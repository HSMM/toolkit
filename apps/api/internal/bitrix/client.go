// Package bitrix contains the small Bitrix24 REST/OAuth client used by auth.
package bitrix

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

type Client struct {
	PortalURL    string
	ClientID     string
	ClientSecret string
	HTTPClient   *http.Client
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Expires      int    `json:"expires"`
	Domain       string `json:"domain"`
	MemberID     string `json:"member_id"`
}

type User struct {
	ID             string          `json:"ID"`
	Email          string          `json:"EMAIL"`
	Name           string          `json:"NAME"`
	LastName       string          `json:"LAST_NAME"`
	SecondName     string          `json:"SECOND_NAME"`
	PersonalMobile string          `json:"PERSONAL_MOBILE"`
	WorkPhone      string          `json:"WORK_PHONE"`
	WorkPosition   string          `json:"WORK_POSITION"`
	PersonalPhoto  string          `json:"PERSONAL_PHOTO"`
	UFDepartment   json.RawMessage `json:"UF_DEPARTMENT"`
	// Возвращаются user.get'ом, в user.current их нет — поэтому RawMessage,
	// чтобы переварить и bool ("ACTIVE": true) и Bitrix-овский string "Y"/"N".
	ActiveRaw   json.RawMessage `json:"ACTIVE,omitempty"`
	UserType    string          `json:"USER_TYPE,omitempty"`
}

// IsActive — толерантный парсинг ACTIVE: true/false или "Y"/"N".
func (u *User) IsActive() bool {
	s := strings.Trim(strings.TrimSpace(string(u.ActiveRaw)), `"`)
	return s == "true" || s == "Y" || s == "1"
}

func (c *Client) AuthorizeURL(redirectURI, state string) (string, error) {
	base, err := c.portalEndpoint("/oauth/authorize/")
	if err != nil {
		return "", err
	}
	q := base.Query()
	q.Set("client_id", c.ClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	base.RawQuery = q.Encode()
	return base.String(), nil
}

func (c *Client) ExchangeCode(ctx context.Context, code, redirectURI, serverDomain string) (*TokenResponse, error) {
	endpoint, err := c.oauthEndpoint(serverDomain, "/oauth/token/")
	if err != nil {
		return nil, err
	}
	q := endpoint.Query()
	q.Set("grant_type", "authorization_code")
	q.Set("client_id", c.ClientID)
	q.Set("client_secret", c.ClientSecret)
	q.Set("code", code)
	q.Set("redirect_uri", redirectURI)
	endpoint.RawQuery = q.Encode()

	var out TokenResponse
	if err := c.getJSON(ctx, endpoint.String(), &out); err != nil {
		return nil, err
	}
	if out.AccessToken == "" {
		return nil, fmt.Errorf("bitrix: token response without access_token")
	}
	return &out, nil
}

func (c *Client) CurrentUser(ctx context.Context, accessToken string) (*User, error) {
	endpoint, err := c.restEndpoint("/rest/user.current")
	if err != nil {
		return nil, err
	}
	q := endpoint.Query()
	q.Set("auth", accessToken)
	endpoint.RawQuery = q.Encode()

	var envelope struct {
		Result User   `json:"result"`
		Error  string `json:"error"`
		Desc   string `json:"error_description"`
	}
	if err := c.getJSON(ctx, endpoint.String(), &envelope); err != nil {
		return nil, err
	}
	if envelope.Error != "" {
		return nil, fmt.Errorf("bitrix: %s: %s", envelope.Error, envelope.Desc)
	}
	if envelope.Result.ID == "" {
		return nil, fmt.Errorf("bitrix: user.current response without ID")
	}
	return &envelope.Result, nil
}

// RefreshAccessToken обменивает refresh_token на пару новых токенов.
// Bitrix24 одноразовые refresh — после успешного обмена старый невалиден,
// новый из ответа нужно сохранить (TokenResponse.RefreshToken).
func (c *Client) RefreshAccessToken(ctx context.Context, refreshToken, serverDomain string) (*TokenResponse, error) {
	endpoint, err := c.oauthEndpoint(serverDomain, "/oauth/token/")
	if err != nil {
		return nil, err
	}
	q := endpoint.Query()
	q.Set("grant_type", "refresh_token")
	q.Set("client_id", c.ClientID)
	q.Set("client_secret", c.ClientSecret)
	q.Set("refresh_token", refreshToken)
	endpoint.RawQuery = q.Encode()

	var out TokenResponse
	if err := c.getJSON(ctx, endpoint.String(), &out); err != nil {
		return nil, fmt.Errorf("bitrix refresh_token: %w", err)
	}
	if out.AccessToken == "" {
		return nil, fmt.Errorf("bitrix: refresh response without access_token")
	}
	return &out, nil
}

// ListEmployees вызывает user.get через OAuth-токен локального приложения.
// FILTER USER_TYPE=employee исключает экстранет. Bitrix24 отдаёт по 50
// пользователей за страницу; `next` в ответе — start-параметр для следующей
// страницы (0/-1 = конец).
func (c *Client) ListEmployees(ctx context.Context, accessToken string, start int) (users []User, next int, err error) {
	if strings.TrimSpace(accessToken) == "" {
		return nil, 0, fmt.Errorf("bitrix: access token is empty")
	}
	endpoint, err := c.restEndpoint("/rest/user.get.json")
	if err != nil {
		return nil, 0, err
	}
	q := endpoint.Query()
	q.Set("auth", accessToken)
	q.Set("FILTER[USER_TYPE]", "employee")
	q.Set("FILTER[ACTIVE]", "Y")
	q.Set("ADMIN_MODE", "true") // вернуть всех, не только видимых вызывающему
	if start > 0 {
		q.Set("start", fmt.Sprint(start))
	}
	endpoint.RawQuery = q.Encode()

	var envelope struct {
		Result []User      `json:"result"`
		Next   json.Number `json:"next"`
		Error  string      `json:"error"`
		Desc   string      `json:"error_description"`
	}
	if err := c.getJSON(ctx, endpoint.String(), &envelope); err != nil {
		return nil, 0, err
	}
	if envelope.Error != "" {
		return nil, 0, fmt.Errorf("bitrix user.get: %s: %s", envelope.Error, envelope.Desc)
	}
	if envelope.Next != "" {
		if n, err := envelope.Next.Int64(); err == nil {
			next = int(n)
		}
	}
	return envelope.Result, next, nil
}

func (u *User) FullName() string {
	parts := []string{u.LastName, u.Name, u.SecondName}
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return strings.TrimSpace(u.Email)
	}
	return strings.Join(out, " ")
}

func (u *User) Phone() string {
	if strings.TrimSpace(u.WorkPhone) != "" {
		return strings.TrimSpace(u.WorkPhone)
	}
	return strings.TrimSpace(u.PersonalMobile)
}

func (u *User) Department() string {
	var ids []int
	if err := json.Unmarshal(u.UFDepartment, &ids); err == nil && len(ids) > 0 {
		return fmt.Sprint(ids[0])
	}
	var stringsList []string
	if err := json.Unmarshal(u.UFDepartment, &stringsList); err == nil && len(stringsList) > 0 {
		return stringsList[0]
	}
	var s string
	if err := json.Unmarshal(u.UFDepartment, &s); err == nil {
		return s
	}
	return ""
}

func (c *Client) getJSON(ctx context.Context, rawURL string, out any) error {
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bitrix request: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("bitrix: unexpected status %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("bitrix body read: %w", err)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("bitrix decode: %w; body: %s", err, responseSnippet(body))
	}
	return nil
}

func (c *Client) portalEndpoint(p string) (*url.URL, error) {
	u, err := url.Parse(c.PortalURL)
	if err != nil {
		return nil, fmt.Errorf("bitrix portal url: %w", err)
	}
	u.Path = path.Join(u.Path, p)
	if strings.HasSuffix(p, "/") && !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	return u, nil
}

func (c *Client) restEndpoint(p string) (*url.URL, error) {
	return c.portalEndpoint(p)
}

func (c *Client) oauthEndpoint(serverDomain, p string) (*url.URL, error) {
	serverDomain = strings.TrimSpace(serverDomain)
	if serverDomain == "" {
		return c.portalEndpoint(p)
	}
	if !strings.Contains(serverDomain, "://") {
		serverDomain = "https://" + serverDomain
	}
	u, err := url.Parse(serverDomain)
	if err != nil {
		return nil, fmt.Errorf("bitrix oauth server url: %w", err)
	}
	if u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("bitrix oauth server url: expected https host")
	}
	u.Path = path.Join(u.Path, p)
	if strings.HasSuffix(p, "/") && !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	return u, nil
}

func responseSnippet(body []byte) string {
	s := strings.TrimSpace(string(body))
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}
