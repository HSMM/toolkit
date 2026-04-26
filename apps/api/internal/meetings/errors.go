package meetings

import "errors"

var (
	ErrNotFound  = errors.New("meeting not found")
	ErrForbidden = errors.New("forbidden")
	ErrEnded     = errors.New("meeting already ended")
)
