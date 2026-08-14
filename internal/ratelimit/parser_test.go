package ratelimit

import (
	"testing"
	"time"
)

func TestParseRateLimit(t *testing.T) {
	tests := []struct {
		name    string
		expr    string
		want    *RateLimit
		wantErr bool
	}{
		{
			name: "empty string",
			expr: "",
			want: nil,
		},
		{
			name: "requests per second",
			expr: "100/s",
			want: &RateLimit{Requests: 100, Window: time.Second},
		},
		{
			name: "requests per minute",
			expr: "100/m",
			want: &RateLimit{Requests: 100, Window: time.Minute},
		},
		{
			name: "requests per hour",
			expr: "1000/h",
			want: &RateLimit{Requests: 1000, Window: time.Hour},
		},
		{
			name: "requests per day",
			expr: "10000/d",
			want: &RateLimit{Requests: 10000, Window: 24 * time.Hour},
		},
		{
			name: "requests per 10 seconds",
			expr: "50/10s",
			want: &RateLimit{Requests: 50, Window: 10 * time.Second},
		},
		{
			name: "requests per 5 minutes",
			expr: "200/5m",
			want: &RateLimit{Requests: 200, Window: 5 * time.Minute},
		},
		{
			name: "requests per 2 hours",
			expr: "5000/2h",
			want: &RateLimit{Requests: 5000, Window: 2 * time.Hour},
		},
		{
			name:    "invalid format - no slash",
			expr:    "100m",
			wantErr: true,
		},
		{
			name:    "invalid format - no unit",
			expr:    "100/",
			wantErr: true,
		},
		{
			name:    "invalid format - invalid unit",
			expr:    "100/x",
			wantErr: true,
		},
		{
			name:    "invalid format - zero requests",
			expr:    "0/m",
			wantErr: true,
		},
		{
			name:    "invalid format - negative requests",
			expr:    "-100/m",
			wantErr: true,
		},
		{
			name:    "invalid format - zero multiplier",
			expr:    "100/0m",
			wantErr: true,
		},
		{
			name:    "invalid format - non-numeric requests",
			expr:    "abc/m",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseRateLimit(tt.expr)
			if (err != nil) != tt.wantErr {
				t.Errorf("ParseRateLimit() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if tt.want == nil && got != nil {
				t.Errorf("ParseRateLimit() = %v, want nil", got)
				return
			}
			if tt.want != nil && got == nil {
				t.Errorf("ParseRateLimit() = nil, want %v", tt.want)
				return
			}
			if tt.want != nil && got != nil {
				if got.Requests != tt.want.Requests {
					t.Errorf("ParseRateLimit().Requests = %v, want %v", got.Requests, tt.want.Requests)
				}
				if got.Window != tt.want.Window {
					t.Errorf("ParseRateLimit().Window = %v, want %v", got.Window, tt.want.Window)
				}
			}
		})
	}
}
