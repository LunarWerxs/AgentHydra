# Capability-specific provider operations

H Swarm uses the same canonical provider key pool for its chat and service transports. Media,
speech, search and observability APIs have their own request and response schemas. Their provider
TOMLs declare authenticated REST operations, and H Swarm refuses to send them chat completions.
The Inworld provider supports both its chat router and speech operations with the same Basic credential.

List a provider's supported operations without loading a key or making a network call:

```powershell
hswarm service tavily
hswarm service elevenlabs
hswarm service runpod
```

Each listing includes capabilities, operation names, HTTP paths and the provider's official documentation.
Payloads use the provider's schema. For example, `search.json` can contain `{"query":"example topic"}`:

```powershell
hswarm service tavily search --input search.json
hswarm service elevenlabs synthesize --path voice_id=example --input speech.json --output speech.mp3
hswarm service stabilityai generate --input image.json --output result.json
hswarm service runpod run --path endpoint_id=example --input inference.json
```

The ElevenLabs `speech.json` contains the documented text/model fields. The Stability JSON contains
form field values, including `prompt`; H Swarm turns it into multipart form data automatically.
Use `--file FIELD=PATH` when an operation accepts file parts. Binary audio responses require
`--output PATH` before H Swarm sends the request. JSON media responses can contain base64 data or
temporary URLs, as specified by the provider.

Asynchronous services return a job, generation or chat ID. H Swarm reports the selected key fingerprint;
use that same `--key-fingerprint` for polling so the request stays with the account which created it:

```powershell
hswarm service runpod get_status --path endpoint_id=example --path job_id=example --key-fingerprint=0123abcd
hswarm service coze get_chat --param conversation_id=example --param chat_id=example --key-fingerprint=0123abcd
hswarm service coze list_chat_messages --param conversation_id=example --param chat_id=example --key-fingerprint=0123abcd
```

These are complete REST responses. Set `stream` to false for Coze agent calls. WebSockets, realtime
streams and automatic polling are outside this adapter. POSTs are sent once; an ambiguous network
failure is reported without retrying a potentially charged generation.

| Provider | Supported operations |
| --- | --- |
| AssemblyAI | Create, retrieve and list transcripts |
| Cartesia | Speech synthesis and voice catalog |
| Coze | Agent catalog, conversation metadata, initiate/poll an agent chat and retrieve messages |
| Deepgram | Transcribe an audio URL, synthesize speech and list projects |
| ElevenLabs | Speech synthesis, voice catalog and subscription metadata |
| Hume | Speech synthesis and voice catalog |
| Ideogram | Ideogram 4 image generation and generation polling |
| Inworld | Speech synthesis, voice catalog and model catalog; chat through `inworld:<model ID>` |
| Jina AI | Embeddings, reranking, web reading and web search |
| LangSmith | Query traces and list tracing projects |
| Leonardo | Image generation and generation polling |
| Luma | Image/video generation and generation polling |
| Pinecone | List/describe indexes, hosted embeddings/reranking, vector query/upsert and index statistics |
| Replicate | Submit, retrieve and list model predictions |
| Runpod | Endpoint-specific inference, job status and endpoint health |
| Runway | Image-to-video generation and task polling |
| Stability AI | Stable Image Core generation, account and balance |
| StepFun | Account model catalog; chat through `stepfun:<model ID>` |
| Tavily | Web search |
| Voiceflow | Project-key interaction through the documented legacy endpoint; create a v4 session for a project/environment |

Runpod needs an existing endpoint ID and that endpoint's input schema. Voiceflow's `interact` operation
uses the documented legacy project-key endpoint, which is deprecated but remains available. Its v4
session creation returns a session key; v4 interaction needs that session key and a session-aware client.
Organization-scoped LangSmith keys can require a workspace header in the user's provider
TOML. Inworld's copied credential is already Base64; H Swarm applies the `Basic` prefix without
encoding it again. Provider permissions, credits and model availability still govern requests.

Jina's `read` and `search` operations POST JSON to their separate official hosts,
`https://r.jina.ai/` and `https://s.jina.ai/`. Use `{"url":"https://example.com"}` for reading
and `{"q":"example topic"}` for searching. Both request JSON responses. The `embeddings` and
`rerank` operations use `https://api.jina.ai/v1/embeddings` and `/v1/rerank`, respectively.
Reading and searching can consume tokens; a public landing page does not validate a key.
See the [Jina API reference](https://api.jina.ai/scalar) and
[official Reader/Search examples](https://github.com/jina-ai/meta-prompt/blob/main/v12.txt).

```powershell
hswarm service jina read --input reader.json
hswarm service jina search --input search.json
```

Pinecone index operations require the index's data-plane host and a key for its project. First
describe the index, selecting a project key by fingerprint when more than one key is available:

```powershell
hswarm service pinecone describe_index --path index_name=example --key-fingerprint=0123abcd
```

Copy the returned `host` into the user provider overlay, `~/.hswarm/providers/pinecone.toml`
(or `providers/pinecone.toml` under `HSWARM_HOME`). The overlay contains configuration only;
keep the key in H Swarm's canonical key pool:

```toml
index_host = "https://example-index.svc.example-region.pinecone.io"
```

Use the actual host returned for that index. `query`, `upsert` and `index_stats` use this
configured HTTPS host, validated against the `.svc.*.pinecone.io` pattern. Pass the same
`--key-fingerprint` to keep the operation with the index's project. `list_indexes`,
`describe_index`, `embed` and `rerank` use the control-plane/inference host `https://api.pinecone.io`.
See the [Pinecone API reference](https://docs.pinecone.io/reference/api/2025-10).

```powershell
hswarm service pinecone query --input query.json --key-fingerprint=0123abcd
hswarm service pinecone upsert --input vectors.json --key-fingerprint=0123abcd
hswarm service pinecone index_stats --key-fingerprint=0123abcd
```

StepFun defaults to the international standard API, `https://api.stepfun.ai/v1`. A China-issued
key needs the China account's `https://api.stepfun.com/v1` endpoint. Set that `base_url` in the
user's `~/.hswarm/providers/stepfun.toml` overlay when applicable; H Swarm does not try keys across
regional account systems. Step Plan subscriptions also require their account-specific
`/step_plan/v1` endpoint. The model catalog also includes speech synthesis, realtime and image models;
`chat_model_pattern` keeps those out of chat discovery while allowing the documented Step, Step-R,
StepAudio chat and Step-1o vision models, which return text through Chat Completions. See
[StepFun's official regional endpoints](https://github.com/stepfun-ai/Step-3.5-Flash) and
[chat API](https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create).

New language-model catalogs are reachable by explicit model ID through `baseten:`, `chutes:`,
`dashscope:`, `xai:` (provider `grok_xai`), `nebius:`, `openai:`, `together:`, `inworld:` and
`stepfun:`. These carry no guessed
token prices or benchmark ranking. An evaluated AUTO route is added only with supporting evidence.

DashScope's built-in URL is its legacy international Singapore endpoint. API keys are regional;
configure the account's documented region/workspace `base_url` in the local provider overlay.
An authentication refusal from another region does not establish that a key is revoked.
See [Alibaba's OpenAI compatibility and regional endpoint documentation](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope).
Providers without a chat model catalog endpoint still accept explicit model IDs through their prefix.

Provider operations are configurable in `providers/<provider>.toml`: `transport`, `capabilities`,
`auth_header`, `auth_prefix`, fixed `headers`, and an `operations` table. An operation declares
`method`, relative `path`, `capability`, `input` (`json`, `multipart`, or `bytes`) and `response`
(`json`, `bytes`, or `text`). Path placeholders are supplied separately with `--path NAME=VALUE`;
query parameters use `--param NAME=VALUE`. An operation can declare a fixed `base_url` with
`allowed_hosts`, as Jina does, or resolve its target from a named provider setting with
`base_url_field` and `allowed_host_pattern`, as Pinecone does with `index_host`. Overridden targets
require HTTPS and must pass their host restriction; URL credentials, queries and fragments (even an
empty `?` or `#`) are rejected. These targets come from provider configuration, not operation payloads
or path parameters. A provider's own `base_url` is used as given, `http://` included, for a local mock
or a self-hosted runtime. API keys stay in headers, and egress receipts contain body hashes, the host
each request went to and the endpoint's path template, without payloads or path/query values.

A provider file can cap each key with a `[limits]` table: `key_rpm` (requests that may start on one key
in a minute) and `key_concurrency` (requests in flight on one key), with `[limits.<operation>]` for an
operation the provider limits differently. Tavily, Cohere, Jina, Cartesia and ElevenLabs declare
their documented figures. A request takes a key with headroom and waits, unsent, while every key is
full; a chat call that could fail over waits no longer than its rest budget. The counts live in one
process, so they hold across the shared server's calls but not between separate `hswarm service`
processes. Each of those starts at a random key of the pool, so parallel calls spread over the keys
instead of all taking the first.
