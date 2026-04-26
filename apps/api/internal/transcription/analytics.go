package transcription

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// AnalyticsResult — статистика по сегментам транскрипта (для UI dashboard).
type AnalyticsResult struct {
	TotalDurationMs    int                       `json:"total_duration_ms"`
	SegmentCount       int                       `json:"segment_count"`
	WordCount          int                       `json:"word_count"`
	CharCount          int                       `json:"char_count"`

	// По каналам/спикерам.
	Speakers           []SpeakerStats            `json:"speakers"`

	// Тишина — паузы между сегментами длиннее SilenceThresholdMs.
	SilenceTotalMs     int                       `json:"silence_total_ms"`
	LongestSilenceMs   int                       `json:"longest_silence_ms"`
	SilenceThresholdMs int                       `json:"silence_threshold_ms"`

	// Перебивания — start_ms одного сегмента внутри другого.
	Interruptions      int                       `json:"interruptions"`

	// Топ слов (после фильтра стоп-слов и нормализации).
	TopWords           []WordCount               `json:"top_words"`

	// Эмоции (если EMO включён на стороне GigaAM). nil если данных нет.
	Emotions           *EmotionAnalysis          `json:"emotions,omitempty"`
}

// SpeakerStats — статистика по одному спикеру / каналу.
type SpeakerStats struct {
	Speaker      string  `json:"speaker"`        // "channel:0" / "user:..." / "side:internal"
	Label        string  `json:"label"`          // "Канал 0" / "Иванов И." — человекочитаемое
	TalkTimeMs   int     `json:"talk_time_ms"`
	TalkRatioPct float64 `json:"talk_ratio_pct"` // % от total speaking time
	Segments     int     `json:"segments"`
	Words        int     `json:"words"`
}

// WordCount — одна запись топа слов.
type WordCount struct {
	Word  string `json:"word"`
	Count int    `json:"count"`
}

// EmotionAnalysis — данные эмоций. Mono — только Overall, Stereo — Channels.
type EmotionAnalysis struct {
	Overall  *EmotionDist        `json:"overall,omitempty"`
	Channels []ChannelEmotions   `json:"channels,omitempty"`
}

type EmotionDist struct {
	Angry    float64 `json:"angry"`
	Sad      float64 `json:"sad"`
	Neutral  float64 `json:"neutral"`
	Positive float64 `json:"positive"`
}

type ChannelEmotions struct {
	Channel  int         `json:"channel"`
	Emotions EmotionDist `json:"emotions"`
}

// computeAnalytics строит статистику из сегментов + engine_metadata.
func computeAnalytics(v *View) AnalyticsResult {
	const silenceThreshold = 2000 // 2 сек
	res := AnalyticsResult{SilenceThresholdMs: silenceThreshold}

	if len(v.Segments) == 0 {
		return res
	}

	type sp struct{ talkMs, segs, words int }
	by := map[string]*sp{}

	// Сортируем по start_ms (уже должны быть отсортированы из БД, но на всякий).
	segs := make([]SegmentDTO, len(v.Segments))
	copy(segs, v.Segments)
	sort.Slice(segs, func(i, j int) bool { return segs[i].StartMs < segs[j].StartMs })

	totalEnd := 0
	for _, s := range segs {
		if s.EndMs > totalEnd {
			totalEnd = s.EndMs
		}
		dur := s.EndMs - s.StartMs
		if dur < 0 {
			dur = 0
		}
		words := countWords(s.Text)
		res.WordCount += words
		res.CharCount += len([]rune(s.Text))

		st, ok := by[s.SpeakerRef]
		if !ok {
			st = &sp{}
			by[s.SpeakerRef] = st
		}
		st.talkMs += dur
		st.segs++
		st.words += words
	}

	res.TotalDurationMs = totalEnd
	res.SegmentCount = len(segs)

	// Speakers, отсортированные по talk time убыв.
	totalTalk := 0
	for _, st := range by {
		totalTalk += st.talkMs
	}
	for ref, st := range by {
		ratio := 0.0
		if totalTalk > 0 {
			ratio = float64(st.talkMs) / float64(totalTalk) * 100
		}
		res.Speakers = append(res.Speakers, SpeakerStats{
			Speaker:      ref,
			Label:        speakerLabel(ref),
			TalkTimeMs:   st.talkMs,
			TalkRatioPct: round1(ratio),
			Segments:     st.segs,
			Words:        st.words,
		})
	}
	sort.Slice(res.Speakers, func(i, j int) bool {
		return res.Speakers[i].TalkTimeMs > res.Speakers[j].TalkTimeMs
	})

	// Silence — суммарная и максимальная пауза > threshold.
	// Меряем по всему треку (а не per-channel), чтобы видеть «тихие моменты»
	// общего разговора.
	for i := 1; i < len(segs); i++ {
		gap := segs[i].StartMs - segs[i-1].EndMs
		if gap > silenceThreshold {
			res.SilenceTotalMs += gap
			if gap > res.LongestSilenceMs {
				res.LongestSilenceMs = gap
			}
		}
	}

	// Interruptions — сегмент начинается, пока другой ещё говорит.
	// Считаем только когда говорящие разные.
	for i := 1; i < len(segs); i++ {
		for j := 0; j < i; j++ {
			if segs[j].EndMs > segs[i].StartMs && segs[j].SpeakerRef != segs[i].SpeakerRef {
				res.Interruptions++
				break
			}
		}
	}

	// Top words.
	res.TopWords = topWords(segs, 15)

	// Emotions из engine_metadata.emo.
	res.Emotions = extractEmotions(v)

	return res
}

func speakerLabel(ref string) string {
	switch {
	case strings.HasPrefix(ref, "channel:"):
		return "Канал " + strings.TrimPrefix(ref, "channel:")
	case strings.HasPrefix(ref, "side:"):
		switch strings.TrimPrefix(ref, "side:") {
		case "internal":
			return "Внутренняя сторона"
		case "external":
			return "Внешняя сторона"
		}
		return ref
	case strings.HasPrefix(ref, "external:"):
		return strings.TrimPrefix(ref, "external:")
	case strings.HasPrefix(ref, "user:"):
		return "Сотрудник"
	}
	return ref
}

// countWords — количество "слов" в тексте (рунические split + фильтр пустых).
func countWords(s string) int {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	n := 0
	inWord := false
	for _, r := range s {
		isLetter := unicode.IsLetter(r) || unicode.IsDigit(r)
		if isLetter && !inWord {
			n++
			inWord = true
		} else if !isLetter {
			inWord = false
		}
	}
	return n
}

// topWords — простейший top-N. Лоwerкейс, без пунктуации, фильтр стоп-слов.
func topWords(segs []SegmentDTO, n int) []WordCount {
	freq := map[string]int{}
	for _, s := range segs {
		for _, w := range tokenize(s.Text) {
			if isStopWord(w) || len([]rune(w)) < 3 {
				continue
			}
			freq[w]++
		}
	}
	out := make([]WordCount, 0, len(freq))
	for w, c := range freq {
		out = append(out, WordCount{Word: w, Count: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Word < out[j].Word
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func tokenize(s string) []string {
	var (
		out []string
		buf []rune
	)
	flush := func() {
		if len(buf) > 0 {
			out = append(out, strings.ToLower(string(buf)))
			buf = buf[:0]
		}
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			buf = append(buf, r)
		} else {
			flush()
		}
	}
	flush()
	return out
}

// isStopWord — мини-список самых частых русских (и нескольких английских) стоп-слов.
// Не претендует на полноту; для серьёзной аналитики стоит подключить полноценный список.
func isStopWord(w string) bool {
	_, ok := stopWords[w]
	return ok
}

var stopWords = map[string]struct{}{
	"и": {}, "в": {}, "не": {}, "на": {}, "я": {}, "что": {}, "с": {}, "это": {}, "но": {},
	"же": {}, "уже": {}, "по": {}, "за": {}, "от": {}, "до": {}, "из": {}, "для": {}, "о": {},
	"вот": {}, "там": {}, "тут": {}, "так": {}, "если": {}, "или": {}, "то": {}, "как": {},
	"мы": {}, "вы": {}, "он": {}, "она": {}, "они": {}, "оно": {}, "ты": {}, "ну": {},
	"да": {}, "нет": {}, "ага": {}, "угу": {}, "эй": {}, "эээ": {}, "это": {}, "этот": {},
	"эта": {}, "эти": {}, "будет": {}, "был": {}, "была": {}, "были": {}, "быть": {},
	"меня": {}, "мне": {}, "тебя": {}, "тебе": {}, "его": {}, "ему": {}, "её": {}, "ей": {},
	"их": {}, "им": {}, "нам": {}, "нас": {}, "вам": {}, "вас": {}, "себя": {}, "себе": {},
	"the": {}, "and": {}, "of": {}, "to": {}, "a": {}, "in": {}, "is": {}, "it": {}, "you": {},
}

// extractEmotions парсит engine_metadata.emo в нашу типизированную форму.
// Mono: emo = {angry, sad, neutral, positive}
// Stereo: emo = [{channel: N, emotions: {...}}, ...]
// EMO выключен или поле null → возвращаем nil.
func extractEmotions(v *View) *EmotionAnalysis {
	if v == nil || len(v.EngineMetadata) == 0 {
		return nil
	}
	var meta struct {
		Emo json.RawMessage `json:"emo"`
	}
	if err := json.Unmarshal(v.EngineMetadata, &meta); err != nil {
		return nil
	}
	if len(meta.Emo) == 0 || string(meta.Emo) == "null" {
		return nil
	}
	// Сначала пробуем стерео (массив).
	var stereo []ChannelEmotions
	if err := json.Unmarshal(meta.Emo, &stereo); err == nil && len(stereo) > 0 {
		return &EmotionAnalysis{Channels: stereo}
	}
	// Иначе моно (объект).
	var mono EmotionDist
	if err := json.Unmarshal(meta.Emo, &mono); err == nil {
		return &EmotionAnalysis{Overall: &mono}
	}
	return nil
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

// buildTextExport — простой плоский текст для скачивания.
func buildTextExport(v *View) string {
	var sb strings.Builder
	sb.WriteString("Транскрипт: " + v.Filename + "\n")
	sb.WriteString("Загружен: " + v.UploadedAt.Format("2006-01-02 15:04 MST") + "\n")
	sb.WriteString(fmt.Sprintf("Размер: %.1f МБ · Длительность: %s · Сегментов: %d\n",
		float64(v.SizeBytes)/1024/1024,
		fmtDuration(maxEndMs(v.Segments)),
		len(v.Segments)))
	sb.WriteString(strings.Repeat("─", 60) + "\n\n")

	for _, s := range v.Segments {
		sb.WriteString(fmt.Sprintf("[%s — %s] %s:\n%s\n\n",
			fmtDuration(s.StartMs), fmtDuration(s.EndMs),
			speakerLabel(s.SpeakerRef), s.Text))
	}
	return sb.String()
}

func maxEndMs(segs []SegmentDTO) int {
	m := 0
	for _, s := range segs {
		if s.EndMs > m {
			m = s.EndMs
		}
	}
	return m
}

func fmtDuration(ms int) string {
	totalSec := ms / 1000
	h := totalSec / 3600
	m := (totalSec % 3600) / 60
	s := totalSec % 60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}

// sanitizeFilename убирает /, \, .. и непечатные символы из имени файла
// (для безопасного Content-Disposition).
func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "transcript"
	}
	// Убираем расширение (мы добавим .txt сами).
	if dot := strings.LastIndex(name, "."); dot >= 0 {
		name = name[:dot]
	}
	var sb strings.Builder
	for _, r := range name {
		switch {
		case r == '/' || r == '\\' || r == '"' || r < 32:
			sb.WriteRune('_')
		default:
			sb.WriteRune(r)
		}
	}
	out := sb.String()
	if out == "" || out == "." || out == ".." {
		return "transcript"
	}
	return out
}

