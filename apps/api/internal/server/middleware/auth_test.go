package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBearerToken_Extract(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"Bearer abc", "abc"},
		{"bearer xyz", "xyz"},
		{"Bearer  spaces ", "spaces"},
		{"", ""},
		{"Basic foo", ""},
		{"Bearer", ""},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		got := bearerToken(r)
		if got != c.want {
			t.Errorf("bearerToken(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestWriteAuthError_JSONShape(t *testing.T) {
	w := httptest.NewRecorder()
	writeAuthError(w, http.StatusUnauthorized, "bad token")
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: got %d want 401", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `"code":"Unauthorized"`) {
		t.Errorf("missing code: %s", body)
	}
	if !strings.Contains(body, `"message":"bad token"`) {
		t.Errorf("missing message: %s", body)
	}
}

func TestEscapeJSON_DoesNotBreakOutOfString(t *testing.T) {
	// Adversarial input: must not unescape into raw JSON.
	out := escapeJSON(`"hax"; alert(1)`)
	if strings.Contains(out, `"hax"`) {
		t.Errorf("unescaped quotes leaked through: %s", out)
	}
}
