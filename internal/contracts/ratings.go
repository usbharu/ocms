package contracts

import (
	"errors"
	"net/url"
	"strings"
)

// RatingLevel returns -1 for an invalid or unclassified rating.
func RatingLevel(rating string) int {
	switch rating {
	case "general":
		return 0
	case "sensitive":
		return 1
	case "questionable":
		return 2
	case "explicit":
		return 3
	default:
		return -1
	}
}

func ValidRating(rating string) bool {
	return rating == "unrated" || RatingLevel(rating) >= 0
}

// nil means no filter; an explicitly empty selection matches no Assets.
func MatchesRating(rating string, selected []string) bool {
	if selected == nil {
		return true
	}
	for _, value := range selected {
		if rating == value {
			return true
		}
	}
	return false
}

func ParseRatings(query url.Values) ([]string, error) {
	values, ok := query["ratings"]
	if !ok {
		return nil, nil
	}
	if len(values) != 1 {
		return nil, errors.New("duplicate rating filter")
	}
	ratings := []string{}
	if values[0] != "" {
		ratings = strings.Split(values[0], ",")
	}
	for _, rating := range ratings {
		if !ValidRating(rating) {
			return nil, errors.New("invalid rating")
		}
	}
	return ratings, nil
}
