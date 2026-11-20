// Compile advertised regular expressions with Go's RE2 engine, as Go MCP
// clients and gateways do. Reads {"patterns": [...]} as JSON from the file
// named by the first argument and writes one engine result as JSON on stdout.
// Standard library only.
package main

import (
	"encoding/json"
	"os"
	"regexp"
	"runtime"
)

type failure struct {
	Index int    `json:"index"`
	Error string `json:"error"`
}

type result struct {
	Engine   string    `json:"engine"`
	Kind     string    `json:"kind"`
	Version  string    `json:"version"`
	Failures []failure `json:"failures"`
}

func main() {
	var input struct {
		Patterns []string `json:"patterns"`
	}
	request, err := os.ReadFile(os.Args[1])
	if err != nil {
		os.Stderr.WriteString("unreadable pattern input: " + err.Error() + "\n")
		os.Exit(2)
	}
	if err := json.Unmarshal(request, &input); err != nil {
		os.Stderr.WriteString("invalid pattern input: " + err.Error() + "\n")
		os.Exit(2)
	}
	output := result{Engine: "go regexp (RE2)", Kind: "pattern", Version: runtime.Version(), Failures: []failure{}}
	for index, pattern := range input.Patterns {
		if _, err := regexp.Compile(pattern); err != nil {
			output.Failures = append(output.Failures, failure{Index: index, Error: err.Error()})
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string][]result{"results": {output}}); err != nil {
		os.Exit(2)
	}
}
