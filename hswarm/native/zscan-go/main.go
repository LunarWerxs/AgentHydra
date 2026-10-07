// Command zscan is the Claude Code transcript scanner behind `hswarm savings`, as a native binary.
//
// Same algorithm, same numbers as hswarm/claude_usage.py (the reference): walk a projects tree, take
// every .jsonl written since the window opened (main transcripts before sub-agent ones), look only at
// the lines carrying "usage", skip a requestId already seen without parsing it, count each request
// once, bucket by LOCAL day, price at the table read from stdin, and report per day the USD split
// main loop vs sub-agents plus every sub-agent's USD and token buckets. Nothing is rounded here: the
// Python side rounds, so every arm prints the same digits.
//
//	zscan --root <dir> --since YYYY-MM-DD --until YYYY-MM-DD [--threads N]  < prices.json
//
// prices.json: [{"prefix": "claude-sonnet-5", "in": 2.0, "out": 10.0, "read_x": 0.1}, ...], first
// matching prefix wins. A tiered row (Haiku 5.5) adds over_at, over_in, over_out and over_read_x: a request
// whose prompt (input + cache reads + cache writes) is over over_at pays those. With --threads N the files
// are read by N workers and folded in file order, so the numbers are the single-threaded scan's.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var (
	usageNeedle = []byte(`"usage"`)
	ridNeedle   = []byte(`"requestId":"`)
)

// The families, in the order a model id is tested against them.
var families = [4]string{"sonnet", "opus", "fable", "haiku"}

type price struct {
	Prefix string  `json:"prefix"`
	In     float64 `json:"in"`
	Out    float64 `json:"out"`
	ReadX  float64 `json:"read_x"`

	// The long-prompt tier; OverAt 0 means the row has none.
	OverAt    int64   `json:"over_at"`
	OverIn    float64 `json:"over_in"`
	OverOut   float64 `json:"over_out"`
	OverReadX float64 `json:"over_read_x"`
}

// Only the fields the scan reads; the decoder skips the rest (the message content, most of a line).
type rec struct {
	RequestID string `json:"requestId"`
	Timestamp string `json:"timestamp"`
	Message   *msg   `json:"message"`
}

type msg struct {
	ID    string         `json:"id"`
	Model any            `json:"model"`
	Usage map[string]any `json:"usage"`
}

// The five billable buckets one Anthropic request carries.
type toks struct {
	input     int64
	cacheRead int64
	cache5m   int64
	cache1h   int64
	output    int64
}

func (t *toks) add(o toks) {
	t.input += o.input
	t.cacheRead += o.cacheRead
	t.cache5m += o.cache5m
	t.cache1h += o.cache1h
	t.output += o.output
}

// One accepted record, before the global dedupe and the day filter.
type raw struct {
	rid   string
	day   string
	dayOK bool
	model string
	toks  toks
	ts    string
}

type agentRec struct {
	day      string
	family   string
	model    string
	session  string
	started  string
	workflow bool
	usd      float64
	toks     toks
	requests int64
}

// sessionOf is the FULL session id a transcript belongs to: the file stem for a main transcript, and the
// directory after the project slug for a sub-agent one (projects/<slug>/<session-id>/subagents/...). Full,
// not shortened, because an account is looked up by it on the Python side (accounts.py).
func sessionOf(path string, sub bool) string {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '\\' || r == '/' })
	if !sub {
		if len(parts) == 0 {
			return ""
		}
		return strings.TrimSuffix(parts[len(parts)-1], ".jsonl")
	}
	for i, p := range parts {
		if p == "projects" && i+2 < len(parts) {
			return parts[i+2]
		}
	}
	return ""
}

// agentSession is the session a sub-agent transcript belongs to, as the rule check matches it: the first
// 8 characters, the length the routing gate's log writes.
func agentSession(path string) string {
	r := []rune(sessionOf(path, true))  // runes, not bytes: Python and Rust both take 8 CHARACTERS
	if len(r) > 8 {
		r = r[:8]
	}
	return string(r)
}

type agentEntry struct {
	family   string
	usd      float64
	toks     toks
	requests int64
	model    string
	session  string
	started  string
	workflow bool
}

// Per model id, per day: requests, the USD split main loop vs sub-agents, how many sub-agents ran on it,
// and the token buckets they ran through (counted whether or not the model has a list price).
type modelAgg struct {
	requests int64
	usd      float64
	mainUSD  float64
	subUSD   float64
	agents   int64
	toks     toks
}

// Per session id, per day: what one chat ran. A session is what an account is recognised by (accounts.py).
type sessionAgg struct {
	usd      float64
	requests int64
	toks     toks
}

type day struct {
	claudeUSD float64
	mainUSD   float64
	subUSD    float64
	requests  int64
	unpriced  int64
	agents    []agentEntry
	byModel   map[string]*modelAgg
	toks      toks
	bySession map[string]*sessionAgg
}

type stats struct {
	files      int64
	candidates int64
	parsed     int64
	records    int64
}

// num reads a token count: only a JSON integer counts, a float or an exponent is not a token count.
func num(v any) int64 {
	jn, ok := v.(json.Number)
	if !ok {
		return 0
	}
	s := jn.String()
	if strings.ContainsAny(s, ".eE") {
		return 0
	}
	i, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return i
}

// tokens returns the five billable buckets and whether any raw token field is non-zero (a zero usage
// line is skipped).
func tokens(usage map[string]any) (toks, bool) {
	create := num(usage["cache_creation_input_tokens"])
	var w1h int64
	if cc, ok := usage["cache_creation"].(map[string]any); ok {
		w1h = num(cc["ephemeral_1h_input_tokens"])
	}
	five := create - w1h
	if five < 0 {
		five = 0
	}
	t := toks{
		input:     num(usage["input_tokens"]),
		cacheRead: num(usage["cache_read_input_tokens"]),
		cache5m:   five,
		cache1h:   w1h,
		output:    num(usage["output_tokens"]),
	}
	return t, t.input != 0 || t.cacheRead != 0 || create != 0 || t.output != 0
}

// priceOf has the same arithmetic in the same order as claude_usage.price_tokens, so the floats agree
// bit for bit; false means the model has no known price ("not measured", never zero).
func priceOf(prices []price, model string, t toks) (float64, bool) {
	for _, p := range prices {
		if strings.HasPrefix(model, p.Prefix) {
			in, out, readX := p.In, p.Out, p.ReadX
			if p.OverAt > 0 && t.input+t.cacheRead+t.cache5m+t.cache1h > p.OverAt {
				in, out, readX = p.OverIn, p.OverOut, p.OverReadX
			}
			weightedIn := float64(t.input) + float64(t.cacheRead)*readX + float64(t.cache5m)*1.25 + float64(t.cache1h)*2.0
			return (weightedIn*in + float64(t.output)*out) / 1e6, true
		}
	}
	return 0, false
}

func familyOf(model string) string {
	for _, f := range families {
		if strings.Contains(model, f) {
			return f
		}
	}
	return "other"
}

// quickRid is the requestId without a JSON parse: replayed history is most of the corpus and is
// skipped on sight.
func quickRid(line []byte) ([]byte, bool) {
	i := bytes.Index(line, ridNeedle)
	if i < 0 {
		return nil, false
	}
	start := i + len(ridNeedle)
	end := bytes.IndexByte(line[start:], '"')
	if end < 0 {
		return nil, false
	}
	return line[start : start+end], true
}

// parseDay reads an RFC3339 stamp as the local day it falls on; a stamp that does not parse is no day.
func parseDay(ts string) (string, bool) {
	d, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return "", false
	}
	return d.Local().Format("2006-01-02"), true
}

type dayValue struct {
	day string
	ok  bool
}

// localDay parses every timestamp on the hot path; a minute always maps to one local day (the same
// cache the reference keeps).
func localDay(cache map[string]dayValue, ts string) (string, bool) {
	key := ts
	if len(ts) > 16 && utf8.RuneStart(ts[16]) {
		key = ts[:16]
	}
	if v, ok := cache[key]; ok {
		return v.day, v.ok
	}
	day, ok := parseDay(ts)
	cache[key] = dayValue{day, ok}
	return day, ok
}

// parseCandidate turns one candidate line into a record; false skips it.
func parseCandidate(line []byte, cache map[string]dayValue, st *stats) (raw, bool) {
	st.parsed++
	var r rec
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	if err := dec.Decode(&r); err != nil {
		return raw{}, false
	}
	if r.Message == nil || r.Message.Usage == nil {
		return raw{}, false
	}
	rid := r.RequestID
	if rid == "" {
		rid = r.Message.ID
	}
	if rid == "" {
		return raw{}, false
	}
	t, any := tokens(r.Message.Usage)
	if !any {
		return raw{}, false
	}
	day, ok := localDay(cache, r.Timestamp)
	model, _ := r.Message.Model.(string)
	return raw{rid: rid, day: day, dayOK: ok, model: model, toks: t, ts: r.Timestamp}, true
}

// forEachLine hands every line of path to handle, growing the line across buffer refills: lines can be
// many MB, which is why this never uses a Scanner (its line limit would truncate them).
func forEachLine(path string, handle func(line []byte)) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	rd := bufio.NewReaderSize(f, 1<<20)
	buf := make([]byte, 0, 1<<16)
	for {
		chunk, err := rd.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			buf = append(buf, chunk...)
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(chunk) > 0 { // a last line with no newline is still a line
				buf = append(buf, chunk...)
				handle(buf)
			}
			return
		}
		buf = append(buf, chunk...)
		handle(buf)
		buf = buf[:0]
	}
}

// scanFile walks one transcript, using seen (the requests earlier files counted; nil: none) for the dedupe
// that needs no parse, counting into st, and handing every accepted record to emit.
func scanFile(path string, seen map[string]struct{}, cache map[string]dayValue, st *stats, emit func(raw)) {
	st.files++
	forEachLine(path, func(line []byte) {
		if !bytes.Contains(line, usageNeedle) {
			return
		}
		st.candidates++
		if q, ok := quickRid(line); ok {
			if _, dup := seen[string(q)]; dup {
				return
			}
		}
		if r, ok := parseCandidate(line, cache, st); ok {
			emit(r)
		}
	})
}

type collector struct {
	since, until string
	prices       []price
	seen         map[string]struct{}
	days         map[string]*day
	agents       []*agentRec
	agentIdx     map[string]int
	dayCache     map[string]dayValue
	stats        stats
}

func (c *collector) apply(r raw, agent *string, session string) {
	if _, dup := c.seen[r.rid]; dup {
		return
	}
	if !r.dayOK {
		return
	}
	if r.day < c.since || r.day > c.until {
		return
	}
	c.seen[r.rid] = struct{}{}
	c.stats.records++
	d := c.days[r.day]
	if d == nil {
		d = &day{byModel: map[string]*modelAgg{}, bySession: map[string]*sessionAgg{}}
		c.days[r.day] = d
	}
	d.requests++
	m := d.byModel[r.model]
	if m == nil {
		m = &modelAgg{}
		d.byModel[r.model] = m
	}
	m.requests++
	// Tokens are counted before the price: a model with no list price still ran them.
	d.toks.add(r.toks)
	m.toks.add(r.toks)
	var s *sessionAgg
	if session != "" {
		s = d.bySession[session]
		if s == nil {
			s = &sessionAgg{}
			d.bySession[session] = s
		}
		s.requests++
		s.toks.add(r.toks)
	}
	usd, priced := priceOf(c.prices, r.model, r.toks)
	if !priced {
		d.unpriced++
		return
	}
	d.claudeUSD += usd
	m.usd += usd
	if s != nil {
		s.usd += usd
	}
	if agent != nil {
		d.subUSD += usd
		m.subUSD += usd
	} else {
		d.mainUSD += usd
		m.mainUSD += usd
	}
	if agent == nil {
		return
	}
	idx, ok := c.agentIdx[*agent]
	if !ok {
		wfSep := string(os.PathSeparator) + "workflows" + string(os.PathSeparator)
		c.agents = append(c.agents, &agentRec{day: r.day, family: familyOf(r.model), model: r.model, session: agentSession(*agent), started: r.ts, workflow: strings.Contains(*agent, wfSep)})
		idx = len(c.agents) - 1
		c.agentIdx[*agent] = idx
	}
	a := c.agents[idx]
	a.usd += usd
	a.toks.add(r.toks)
	a.requests++
}

// The single-threaded scan: one file at a time through the same extraction the parallel arm uses, the global
// seen-set (requests earlier files counted) skipping replayed lines before they are parsed.
func (c *collector) readFile(path string, agent *string, session string) {
	raws, st := extractFile(path, c.since, c.until, c.seen, c.dayCache)
	c.stats.files += st.files
	c.stats.candidates += st.candidates
	c.stats.parsed += st.parsed
	for _, r := range raws {
		c.apply(r, agent, session)
	}
}

// finish hangs each sub-agent off the day it started, in first-seen order.
func (c *collector) finish() {
	for _, a := range c.agents {
		if d := c.days[a.day]; d != nil {
			d.agents = append(d.agents, agentEntry{family: a.family, usd: a.usd, toks: a.toks, requests: a.requests, model: a.model, session: a.session, started: a.started, workflow: a.workflow})
			m := d.byModel[a.model]
			if m == nil {
				m = &modelAgg{}
				d.byModel[a.model] = m
			}
			m.agents++
		}
	}
}

// The five buckets alone, as every day, model and session reports them.
type tokensJSON struct {
	Input     int64 `json:"input"`
	CacheRead int64 `json:"cache_read"`
	Cache5m   int64 `json:"cache_5m"`
	Cache1h   int64 `json:"cache_1h"`
	Output    int64 `json:"output"`
}

func buckets(t toks) tokensJSON {
	return tokensJSON{Input: t.input, CacheRead: t.cacheRead, Cache5m: t.cache5m, Cache1h: t.cache1h, Output: t.output}
}

type modelJSON struct {
	Requests int64      `json:"requests"`
	USD      float64    `json:"usd"`
	MainUSD  float64    `json:"main_usd"`
	SubUSD   float64    `json:"sub_usd"`
	Agents   int64      `json:"agents"`
	Tokens   tokensJSON `json:"tokens"`
}

type sessionJSON struct {
	USD      float64    `json:"usd"`
	Requests int64      `json:"requests"`
	Tokens   tokensJSON `json:"tokens"`
}

type agentTokensJSON struct {
	Input     int64   `json:"input"`
	CacheRead int64   `json:"cache_read"`
	Cache5m   int64   `json:"cache_5m"`
	Cache1h   int64   `json:"cache_1h"`
	Output    int64   `json:"output"`
	Requests  int64   `json:"requests"`
	Model     string  `json:"model"`
	Session   string  `json:"session"`
	Started   string  `json:"started"`
	Workflow  bool    `json:"workflow"`
	USD       float64 `json:"usd"`
}

type dayJSON struct {
	ClaudeUSD        float64                      `json:"claude_usd"`
	MainUSD          float64                      `json:"main_usd"`
	SubUSD           float64                      `json:"sub_usd"`
	Requests         int64                        `json:"requests"`
	UnpricedRequests int64                        `json:"unpriced_requests"`
	Agents           map[string][]float64         `json:"agents"`
	AgentTokens      map[string][]agentTokensJSON `json:"agent_tokens"`
	ByModel          map[string]modelJSON         `json:"by_model"`
	Tokens           tokensJSON                   `json:"tokens"`
	BySession        map[string]sessionJSON       `json:"by_session"`
}

type statsJSON struct {
	Files      int64 `json:"files"`
	Candidates int64 `json:"candidates"`
	Parsed     int64 `json:"parsed"`
	Records    int64 `json:"records"`
}

type outJSON struct {
	Days    map[string]*dayJSON `json:"days"`
	Threads int                 `json:"threads"`
	Tiers   bool                `json:"tiers"` // reads the long-prompt tier (over_at); an older build omits it
	Stats   statsJSON           `json:"stats"`
}

func (c *collector) output(threads int) outJSON {
	days := make(map[string]*dayJSON, len(c.days))
	for name, d := range c.days {
		agents := make(map[string][]float64)
		agentTokens := make(map[string][]agentTokensJSON)
		for _, a := range d.agents {
			agents[a.family] = append(agents[a.family], a.usd)
			agentTokens[a.family] = append(agentTokens[a.family], agentTokensJSON{
				Input: a.toks.input, CacheRead: a.toks.cacheRead, Cache5m: a.toks.cache5m,
				Cache1h: a.toks.cache1h, Output: a.toks.output, Requests: a.requests,
				Model: a.model, Session: a.session, Started: a.started, Workflow: a.workflow, USD: a.usd,
			})
		}
		byModel := make(map[string]modelJSON, len(d.byModel))
		for model, m := range d.byModel {
			byModel[model] = modelJSON{Requests: m.requests, USD: m.usd, MainUSD: m.mainUSD, SubUSD: m.subUSD, Agents: m.agents, Tokens: buckets(m.toks)}
		}
		bySession := make(map[string]sessionJSON, len(d.bySession))
		for sid, s := range d.bySession {
			bySession[sid] = sessionJSON{USD: s.usd, Requests: s.requests, Tokens: buckets(s.toks)}
		}
		days[name] = &dayJSON{
			ClaudeUSD: d.claudeUSD, MainUSD: d.mainUSD, SubUSD: d.subUSD,
			Requests: d.requests, UnpricedRequests: d.unpriced, Agents: agents, AgentTokens: agentTokens, ByModel: byModel,
			Tokens: buckets(d.toks), BySession: bySession,
		}
	}
	return outJSON{
		Days: days, Threads: threads, Tiers: true,
		Stats: statsJSON{Files: c.stats.files, Candidates: c.stats.candidates, Parsed: c.stats.parsed, Records: c.stats.records},
	}
}

type fileInfo struct {
	path string
	sub  bool
}

// Every .jsonl under root written since sinceTs: main transcripts first, then sub-agent ones.
func listFiles(root string, sinceTs int64) []fileInfo {
	sep := string(os.PathSeparator) + "subagents" + string(os.PathSeparator)
	var main, sub []fileInfo
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().Unix() < sinceTs {
			return nil
		}
		if strings.Contains(path, sep) {
			sub = append(sub, fileInfo{path: path, sub: true})
		} else {
			main = append(main, fileInfo{path: path})
		}
		return nil
	})
	return append(main, sub...)
}

// One file's requests, each at its fullest line. A streamed request is several lines with one requestId: the
// first is written when the reply starts and carries a placeholder output_tokens (8, say), the last the final
// count, so a request is billed at its largest output (as the reference, usage-tokens.ts and the analytics kit
// count it) and the whole file is read before anything is counted. `global` holds the requests earlier files
// counted (the serial arm's fold in file order; nil for the parallel arm, which folds afterwards): a replayed
// line is skipped before it is parsed.
//
// The window is applied HERE as well, because the local dedupe must see exactly what the global one does: a
// record outside the window is dropped by the fold without marking its id as seen, so if it were allowed to
// claim the id here, a LATER line replaying that same request inside the window would be skipped before it
// was ever parsed and the request would vanish from the parallel arm only. That cost 3 requests and $1.83 of
// a real day, deterministically, in both native arms (A/B, 2026-09-17).
func extractFile(path, since, until string, global map[string]struct{}, cache map[string]dayValue) ([]raw, stats) {
	var st stats
	var out []raw
	at := make(map[string]int) // request id -> its place in out
	scanFile(path, global, cache, &st, func(r raw) {
		if !r.dayOK || r.day < since || r.day > until {
			return // the fold will drop it too, and it must not claim the id a later replay needs
		}
		if i, dup := at[r.rid]; dup {
			if r.toks.output > out[i].toks.output {
				out[i] = r
			}
			return
		}
		at[r.rid] = len(out)
		out = append(out, r)
	})
	return out, st
}

type job struct {
	idx  int
	raws []raw
	st   stats
}

// scanParallel reads the files with n workers and folds their records in file order, holding only the
// files that arrived early, so the numbers match the single-threaded scan.
func (c *collector) scanParallel(files []fileInfo, n int) {
	var mu sync.Mutex
	next := 0
	ch := make(chan job)
	var wg sync.WaitGroup
	for w := 0; w < n; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if next >= len(files) {
					mu.Unlock()
					return
				}
				i := next
				next++
				mu.Unlock()
				raws, st := extractFile(files[i].path, c.since, c.until, nil, make(map[string]dayValue))
				ch <- job{idx: i, raws: raws, st: st}
			}
		}()
	}
	go func() {
		wg.Wait()
		close(ch)
	}()
	pending := make(map[int]job)
	want := 0
	for j := range ch {
		c.stats.files += j.st.files
		c.stats.candidates += j.st.candidates
		c.stats.parsed += j.st.parsed
		pending[j.idx] = j
		for {
			p, ok := pending[want]
			if !ok {
				break
			}
			delete(pending, want)
			agent := subAgent(files[want])
			session := sessionOf(files[want].path, files[want].sub)
			for _, r := range p.raws {
				c.apply(r, agent, session)
			}
			want++
		}
	}
}

// subAgent is the transcript's own path when the file is a sub-agent one, else nil; the collector
// attributes a record to that agent only for sub-agent transcripts.
func subAgent(f fileInfo) *string {
	if !f.sub {
		return nil
	}
	path := f.path
	return &path
}

// parseArgs reads the flag pairs zscan accepts, defaulting --threads to 1 and rejecting anything it
// does not know. A bad flag is fatal, exactly as it is when the scan itself cannot start.
func parseArgs(args []string) (root, since, until string, threads int) {
	threads = 1
	for i := 1; i+1 < len(args); i += 2 {
		switch args[i] {
		case "--root":
			root = args[i+1]
		case "--since":
			since = args[i+1]
		case "--until":
			until = args[i+1]
		case "--threads":
			n, err := strconv.Atoi(args[i+1])
			if err != nil {
				n = 1
			}
			if n < 1 {
				n = 1
			}
			threads = n
		default:
			fmt.Fprintf(os.Stderr, "zscan: unknown argument %s\n", args[i])
			os.Exit(2)
		}
	}
	return root, since, until, threads
}

// readPrices takes the price table off stdin, first matching prefix wins, as the package comment says.
func readPrices() []price {
	pricesJSON, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "zscan: prices on stdin")
		os.Exit(2)
	}
	var prices []price
	if err := json.Unmarshal(pricesJSON, &prices); err != nil {
		fmt.Fprintln(os.Stderr, "zscan: prices: a JSON list of {prefix, in, out, read_x}")
		os.Exit(2)
	}
	return prices
}

// windowStart is local midnight of --since, the cutoff listFiles walks the tree from.
func windowStart(since string) int64 {
	sinceDate, err := time.Parse("2006-01-02", since)
	if err != nil {
		fmt.Fprintln(os.Stderr, "zscan: --since YYYY-MM-DD")
		os.Exit(2)
	}
	return time.Date(sinceDate.Year(), sinceDate.Month(), sinceDate.Day(), 0, 0, 0, 0, time.Local).Unix()
}

// resolvedRoot canonicalizes the root like the Rust arm: a symlinked root would otherwise walk nothing.
func resolvedRoot(root string) string {
	if p, err := filepath.EvalSymlinks(root); err == nil {
		return p
	}
	if abs, err := filepath.Abs(root); err == nil {
		return abs
	}
	return root
}

// scanFiles folds the tree on this goroutine for one worker, or across `threads` workers that still
// fold in file order; both paths produce the same numbers.
func scanFiles(c *collector, files []fileInfo, threads int) {
	if threads <= 1 {
		for _, f := range files {
			c.readFile(f.path, subAgent(f), sessionOf(f.path, f.sub))
		}
		return
	}
	c.scanParallel(files, threads)
}

// emit writes the JSON report to stdout, one trailing newline, and does not return on a marshal error.
func emit(v any) {
	out, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "zscan: %v\n", err)
		os.Exit(2)
	}
	stdout := bufio.NewWriter(os.Stdout)
	stdout.Write(out)
	stdout.WriteByte('\n')
	stdout.Flush()
}

func main() {
	root, since, until, threads := parseArgs(os.Args)
	if root == "" || since == "" || until == "" {
		fmt.Fprintln(os.Stderr, "usage: zscan --root <dir> --since YYYY-MM-DD --until YYYY-MM-DD [--threads N] < prices.json")
		os.Exit(2)
	}
	prices := readPrices()
	sinceTs := windowStart(since)
	files := listFiles(resolvedRoot(root), sinceTs)
	c := &collector{
		since: since, until: until, prices: prices,
		seen: make(map[string]struct{}), days: make(map[string]*day),
		agentIdx: make(map[string]int), dayCache: make(map[string]dayValue),
	}
	scanFiles(c, files, threads)
	c.finish()
	emit(c.output(threads))
}
