package app

// 声明式协议插件宿主与接口类型校验。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"yingce/backend/internal/protocol"
)

// runDeclarativeProtocolTask 是 JSON manifest 插件的宿主运行时。
// manifest 只能描述请求/响应映射；凭证、出站安全策略、轮询和结果下载必须由宿主统一掌握，
// 这样插件不能绕过服务端的鉴权、超时和 SSRF 防护边界。
func runDeclarativeProtocolTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	adapter, ok := declarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
	if !ok {
		return nil, fmt.Errorf("接口类型 %s 未安装声明式适配器", input.Config.InterfaceType)
	}
	return runProtocolAdapterTask(ctx, input, adapter)
}

func runProtocolAdapterTask(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter) (map[string]interface{}, error) {
	return runProtocolAdapterTaskWithPolicy(ctx, input, adapter, declarativeProtocolPollPolicy(input.Mode))
}

func declarativeProtocolPollPolicy(mode string) videoPollPolicy {
	if mode == "video" {
		return defaultVideoPollPolicy()
	}
	return videoPollPolicy{
		Interval:            2500 * time.Millisecond,
		MaxNotFoundMisses:   1,
		MaxDownloadTries:    3,
		TransientRetryLimit: asyncPollTransientRetries(),
		Sleep:               sleepContext,
	}
}

// asyncPollTransientRetriesEnv 是可选设置：非视频声明式异步任务（图片、音频）轮询遇到暂时性错误时，
// 允许连续重试的次数，退避从轮询间隔起倍增、封顶 4 倍。默认 0，保持现有 fail-fast 行为。
const asyncPollTransientRetriesEnv = "CANVAS_ASYNC_POLL_TRANSIENT_RETRIES"

func asyncPollTransientRetries() int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(asyncPollTransientRetriesEnv)))
	if err != nil || value <= 0 {
		return 0
	}
	return min(value, 10)
}

func runProtocolAdapterTaskWithPolicy(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, policy videoPollPolicy) (map[string]interface{}, error) {
	// create、poll、download 是同一个外部任务的三个阶段：任一阶段失败都向上返回真实错误，
	// 不把“已提交但结果未知”伪装成成功，也不把下载失败降级成空结果。
	request := protocolRequestFromInput(input)
	taskID := resumedProviderRequestID(ctx)
	var created protocol.CreateResult
	if taskID == "" {
		// 幂等键只存在于宿主请求元数据中，声明式插件可以把它映射到 Header，
		// 但不能把宿主控制字段泄漏到供应商 JSON body。恢复已有 taskID 时不会进入 create 分支。
		key, _ := ctx.Value(providerSubmissionKeyContext{}).(string)
		if key == "" {
			key = uuid.NewString()
		}
		request.Extra["idempotencyKey"] = key
		spec, err := adapter.BuildCreate(ctx, protocol.RequestContext{BaseURL: input.Config.BaseURL, Request: request})
		if err != nil {
			return nil, err
		}
		// 聚合网关偶发用 5xx 状态码包裹两类 body（GROK 踩坑笔记第五节 + 2026-09-08 实测）：
		// ① 已完成的业务体（status done + 媒体 URL，上游已计费）——解析复用，禁止重提交；
		// ② 真正的瞬时错误体（{"error":{...}}，未生成未扣费）——短退避重试 create。
		// 同步图片类插件对缺失 status 的 body 默认映射成完成态，因此恢复守卫必须
		// 同时要求任务 ID 或真实媒体输出，否则错误体会被误判成「已完成但无结果」。
		// 连接池闲置回收后的重新拨号还会间歇性撞上网络坏窗口（EOF/reset），一并重试。
		recoveredFromTransient := false
		var body []byte
		var streamedResult *protocol.Result
		for createAttempt := 0; ; createAttempt++ {
			body, streamedResult, err = executeProtocolCreateRequest(withProviderRequestKind(ctx, "create"), input, spec)
			if err == nil {
				break
			}
			if recovered, ok := recoverProtocolCreateFromTransientError(ctx, adapter, input.Mode, err); ok {
				// 完成态恢复直接取结果（taskID 可能为空，不能再回头解析错误体）；
				// pending 态恢复（拿到任务 ID）继续走正常轮询。
				if recovered.Status == protocol.StatusSucceeded {
					return finishProtocolAdapterResult(ctx, input, adapter, request, recovered.TaskID, recovered.Result, policy)
				}
				created = recovered
				recoveredFromTransient = true
				break
			}
			if createAttempt == 2 || !retryableUpstreamRequestError(err) {
				return nil, err
			}
			if waitErr := sleepContext(ctx, time.Duration(createAttempt+1)*1500*time.Millisecond); waitErr != nil {
				return nil, err
			}
		}
		if !recoveredFromTransient {
			if err != nil {
				return nil, err
			}
			if streamedResult != nil {
				created = protocol.CreateResult{Status: protocol.StatusSucceeded, Result: streamedResult}
			} else {
				if parser, ok := adapter.(protocol.RequestAwareCreateParser); ok {
					created, err = parser.ParseCreateWithRequest(ctx, request, body)
				} else {
					created, err = adapter.ParseCreate(ctx, body)
				}
			}
			if err != nil {
				return nil, err
			}
		}
		taskID = created.TaskID
		if taskID == "" {
			extracted, extractErr := extractProviderTaskID(body)
			if extractErr != nil {
				return nil, extractErr
			}
			taskID = extracted
		}
		if created.Status == protocol.StatusFailed || created.Status == protocol.StatusCancelled {
			return nil, protocolResultError(created.Message, taskID)
		}
		if created.Status == protocol.StatusSucceeded {
			return finishProtocolAdapterResult(ctx, input, adapter, request, taskID, created.Result, policy)
		}
		if taskID == "" {
			return nil, errors.New("声明式协议创建请求没有返回任务 ID")
		}
	}

	return runVideoPollLoop(ctx, taskID, policy, func(ctx context.Context) (videoPollOutcome, error) {
		spec, err := adapter.BuildPoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID})
		if err != nil {
			return videoPollOutcome{}, err
		}
		body, err := executeProtocolRequest(withProviderRequestKind(ctx, "poll"), input.Config, spec)
		if err != nil {
			return videoPollOutcome{}, err
		}
		state, err := adapter.ParsePoll(ctx, protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}, body)
		if err != nil {
			return videoPollOutcome{}, err
		}
		if state.TaskID != "" {
			taskID = state.TaskID
		}
		switch state.Status {
		case protocol.StatusSucceeded:
			result, err := finishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, policy)
			return videoPollOutcome{Done: err == nil, Result: result}, err
		case protocol.StatusFailed, protocol.StatusCancelled:
			return videoPollOutcome{}, protocolResultError(state.Message, taskID)
		}
		return videoPollOutcome{}, nil
	})
}

func extractProviderTaskID(body []byte) (string, error) {
	var payload map[string]interface{}
	if json.Unmarshal(body, &payload) != nil {
		return "", nil
	}
	id, err := firstJSONString(payload, "id", "task_id", "taskId", "request_id", "name")
	if id != "" {
		return id, nil
	}
	if data, ok := payload["data"].(map[string]interface{}); ok {
		nested, nestedErr := firstJSONString(data, "id", "task_id", "taskId", "request_id")
		if nested != "" {
			return nested, nil
		}
		if nestedErr != nil {
			return "", nestedErr
		}
	}
	return "", err
}

// queryProtocolAdapterVideoTask 只读取一次已有的声明式 Provider 任务。
// 人工恢复走此路径，因此检查本地失败任务时绝不会创建第二个计费任务。
func queryProtocolAdapterVideoTask(ctx context.Context, input canvasGenerationInput, adapter protocol.Adapter, taskID string) (map[string]interface{}, string, error) {
	request := protocolRequestFromInput(input)
	pollContext := protocol.PollContext{BaseURL: input.Config.BaseURL, Model: request.Model, Request: request, TaskID: taskID}
	spec, err := adapter.BuildPoll(ctx, pollContext)
	if err != nil {
		return nil, "", err
	}
	body, err := executeProtocolRequest(withProviderRequestKind(ctx, "poll"), input.Config, spec)
	if err != nil {
		return nil, "", err
	}
	state, err := adapter.ParsePoll(ctx, pollContext, body)
	if err != nil {
		return nil, "", err
	}
	providerStatus := string(state.Status)
	switch state.Status {
	case protocol.StatusSucceeded:
		result, err := finishProtocolAdapterResult(ctx, input, adapter, request, taskID, state.Result, defaultVideoPollPolicy())
		return result, providerStatus, err
	case protocol.StatusFailed, protocol.StatusCancelled:
		return nil, providerStatus, protocolResultError(state.Message, taskID)
	case protocol.StatusPending, protocol.StatusProcessing:
		return nil, providerStatus, nil
	default:
		return nil, providerStatus, fmt.Errorf("声明式协议任务 %s 返回未知状态：%s", taskID, providerStatus)
	}
}

// retryableUpstreamRequestError 瞬时 5xx 或瞬时网络错误，值得短退避重试。
func retryableUpstreamRequestError(err error) bool {
	return retryableUpstreamStatusError(err) || retryableUpstreamNetworkError(err)
}

func retryableUpstreamStatusError(err error) bool {
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	switch httpErr.StatusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout, 524:
		return true
	default:
		return false
	}
}

// retryableUpstreamNetworkError 判定新连接/在途连接被静默断开的瞬时网络错误。
// 连接池闲置回收后重新拨号会间歇性撞上网络坏窗口（Clash 节点切换、GFW RST、
// 路由抖动）；net/http 对 POST 不做自动重试，必须在应用层补。
// 任务取消与整体超时（DeadlineExceeded）不算瞬时——重试只会重复等死。
func retryableUpstreamNetworkError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var networkError net.Error
	if errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary()) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{"tls handshake timeout", "connection reset", "unexpected eof", "broken pipe", "\"eof\"", ": eof"} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// recoverProtocolCreateFromTransientError 尝试把上游瞬时 5xx 响应体按声明式创建
// 响应解析。只有「可续轮询（有任务 ID）」或「真完成（完成态且带该模式的媒体输出）」
// 才返回 ok；错误体（无任务 ID、无输出）一律走原始错误路径，由调用方重试。
// 场景：网关用 502 状态码包裹已完成业务体（已扣费），按状态码丢弃等于让用户白付钱。
func recoverProtocolCreateFromTransientError(ctx context.Context, adapter protocol.Adapter, mode string, requestErr error) (protocol.CreateResult, bool) {
	var httpErr providerHTTPError
	if !errors.As(requestErr, &httpErr) || !retryableUpstreamStatusError(requestErr) {
		return protocol.CreateResult{}, false
	}
	body := []byte(strings.TrimSpace(httpErr.Body))
	if len(body) == 0 || !json.Valid(body) {
		return protocol.CreateResult{}, false
	}
	created, err := adapter.ParseCreate(ctx, body)
	if err != nil {
		return protocol.CreateResult{}, false
	}
	if strings.TrimSpace(created.TaskID) != "" {
		return created, true
	}
	if created.Status == protocol.StatusSucceeded && protocolResultHasOutput(mode, created.Result) {
		return created, true
	}
	return protocol.CreateResult{}, false
}

func validateGenerationInterface(mode string, interfaceType string) error {
	// Standalone callers (including legacy tests and migration tools) may not
	// have a Service/plugin runtime. Use the shipped declarative catalog first;
	// fall back to host builtins only when the package catalog is unavailable.
	registry := loadOfficialFallbackRegistry()
	if registry == nil {
		registry = protocol.Builtins()
	} else if _, ok := registry.Resolve(strings.TrimSpace(interfaceType)); !ok {
		// A deployment may ship only a subset of the optional plugin catalog.
		// Preserve the host-backed builtins for standalone validation instead of
		// reporting a false "not installed" error for those interfaces.
		if _, builtinOK := protocol.Builtins().Resolve(strings.TrimSpace(interfaceType)); builtinOK {
			registry = protocol.Builtins()
		}
	}
	return validateGenerationInterfaceWithRegistry(registry, mode, interfaceType)
}

func (s *Service) validateGenerationInterface(mode string, interfaceType string) error {
	return validateGenerationInterfaceWithRegistry(s.protocolRegistry(), mode, interfaceType)
}

func validateGenerationInterfaceWithRegistry(registry *protocol.Registry, mode string, interfaceType string) error {
	interfaceType = strings.TrimSpace(interfaceType)
	if interfaceType == "" {
		return nil
	}
	adapter, ok := registry.Resolve(interfaceType)
	if !ok {
		return fmt.Errorf("接口类型 %s 未安装", interfaceType)
	}
	metadata := adapter.Metadata()
	if !metadata.Enabled || metadata.UnavailableReason != "" {
		return fmt.Errorf("接口类型 %s 当前不可用：%s", interfaceType, metadata.UnavailableReason)
	}
	if mode != "" && !protocolCapabilityMatches(metadata, protocol.Capability(mode)) {
		return fmt.Errorf("接口类型 %s 不支持%s生成", interfaceType, mode)
	}
	return nil
}

func protocolCapabilityMatches(metadata protocol.Metadata, capability protocol.Capability) bool {
	for _, item := range metadata.Categories {
		if item == capability {
			return true
		}
	}
	return false
}
