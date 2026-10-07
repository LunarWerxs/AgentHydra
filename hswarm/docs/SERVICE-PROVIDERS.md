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
| LangSmith | Query traces and list tracing projects |
| Leonardo | Image generation and generation polling |
| Luma | Image/video generation and generation polling |
| Replicate | Submit, retrieve and list model predictions |
| Runpod | Endpoint-specific inference, job status and endpoint health |
| Runway | Image-to-video generation and task polling |
| Stability AI | Stable Image Core generation, account and balance |
| Tavily | Web search |
| Voiceflow | Project-key interaction through the documented legacy endpoint; create a v4 session for a project/environment |

Runpod needs an existing endpoint ID and that endpoint's input schema. Voiceflow's `interact` operation
uses the documented legacy project-key endpoint, which is deprecated but remains available. Its v4
session creation returns a session key; v4 interaction needs that session key and a session-aware client.
Organization-scoped LangSmith keys can require a workspace header in the user's provider
TOML. Inworld's copied credential is already Base64; H Swarm applies the `Basic` prefix without
encoding it again. Provider permissions, credits and model availability still govern requests.

New language-model catalogs are reachable by explicit model ID through `baseten:`, `chutes:`,
`xai:` (provider `grok_xai`), `nebius:`, `openai:`, `together:` and `inworld:`. These carry no guessed
token prices or benchmark ranking. An evaluated AUTO route is added only with supporting evidence.

Provider operations are configurable in `providers/<provider>.toml`: `transport`, `capabilities`,
`auth_header`, `auth_prefix`, fixed `headers`, and an `operations` table. An operation declares
`method`, relative `path`, `capability`, `input` (`json`, `multipart`, or `bytes`) and `response`
(`json`, `bytes`, or `text`). Path placeholders are supplied separately with `--path NAME=VALUE`;
query parameters use `--param NAME=VALUE`. API keys stay in headers, and egress receipts contain
body hashes and endpoint templates, without payloads or path/query values.
