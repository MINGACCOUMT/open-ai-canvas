package service

import "encoding/json"

func requestAsMap(value interface{}) (map[string]interface{}, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	result := make(map[string]interface{})
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

type newAPIVideoRequest struct {
	Model         string   `json:"model"`
	Prompt        string   `json:"prompt"`
	Seconds       string   `json:"seconds"`
	AspectRatio   string   `json:"aspect_ratio"`
	Resolution    string   `json:"resolution"`
	GenerateAudio *bool    `json:"generate_audio,omitempty"`
	ImageURLs     []string `json:"image_urls,omitempty"`
	VideoURLs     []string `json:"video_urls,omitempty"`
	AudioURLs     []string `json:"audio_urls,omitempty"`
}

type seedanceVideosRequest struct {
	Model              string   `json:"model"`
	Prompt             string   `json:"prompt"`
	AspectRatio        string   `json:"aspect_ratio"`
	Duration           int      `json:"duration"`
	GenerateAudio      *bool    `json:"generate_audio,omitempty"`
	ImageURL           string   `json:"image_url,omitempty"`
	ReferenceImageURLs []string `json:"reference_image_urls,omitempty"`
	ImageURLs          []string `json:"image_urls,omitempty"`
	ReferenceVideos    []string `json:"reference_videos,omitempty"`
	ReferenceAudios    []string `json:"reference_audios,omitempty"`
}

type xaiVideoRequest struct {
	Model              string         `json:"model"`
	Prompt             string         `json:"prompt"`
	Duration           int            `json:"duration"`
	AspectRatio        string         `json:"aspect_ratio"`
	Resolution         string         `json:"resolution"`
	Image              *xaiVideoImage `json:"image,omitempty"`
	// 多图语义参考（官方字段 reference_image_urls）：只引导风格/主体/构图，不强制首帧。
	ReferenceImageURLs []string       `json:"reference_image_urls,omitempty"`
}

type xaiVideoImage struct {
	URL  string `json:"url"`
	Type string `json:"type"`
}

type grokImageRequest struct {
	Model          string           `json:"model"`
	Prompt         string           `json:"prompt"`
	// ImageURL 是单图编辑的稳妥字段（SDK 风格字符串）。
	// 实测：带 Content-Disposition:attachment 的 OSS 签名 URL 用 image:{url,type} 会被 xAI 拒收 400，
	// 改 image_url 字符串后同样 URL 可通过。
	ImageURL       string           `json:"image_url,omitempty"`
	Image          *grokImageInput  `json:"image,omitempty"`
	Images         []grokImageInput `json:"images,omitempty"`
	N              int              `json:"n"`
	ResponseFormat string           `json:"response_format"`
	Size           string           `json:"size,omitempty"`
	AspectRatio    string           `json:"aspect_ratio,omitempty"`
	// Resolution 对应 xAI / grok2api 的 resolution（常见 1k / 2k）。
	Resolution string `json:"resolution,omitempty"`
}

// grokImageInput 对应 xAI 官方 image/images 数组项；type 必须为 "image_url"。
// 单图优先走 ImageURL 字符串；多图仍用 images 数组。
type grokImageInput struct {
	URL  string `json:"url"`
	Type string `json:"type"`
}

type geminiVeoRequest struct {
	Instances  []geminiVeoInstance `json:"instances"`
	Parameters geminiVeoParameters `json:"parameters"`
}

type geminiVeoInstance struct {
	Prompt string          `json:"prompt"`
	Image  *geminiVeoImage `json:"image,omitempty"`
}

type geminiVeoImage struct {
	BytesBase64Encoded string `json:"bytesBase64Encoded"`
	MIMEType           string `json:"mimeType"`
}

type geminiVeoParameters struct {
	AspectRatio     string `json:"aspectRatio"`
	DurationSeconds int    `json:"durationSeconds"`
	Resolution      string `json:"resolution"`
	SampleCount     int    `json:"sampleCount"`
}

type seedanceAgentPlanRequest struct {
	Model         string                   `json:"model"`
	Content       []map[string]interface{} `json:"content"`
	Ratio         string                   `json:"ratio"`
	Resolution    string                   `json:"resolution"`
	Duration      int                      `json:"duration"`
	GenerateAudio *bool                    `json:"generate_audio,omitempty"`
	Watermark     *bool                    `json:"watermark,omitempty"`
}
