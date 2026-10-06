"""Transport-independent SSE framing; JSON interpretation belongs to each provider."""


def frames(lines):
    data, event_name = [], "message"
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.rstrip("\r\n")
        if not line:
            if data:
                yield event_name, "\n".join(data)
            data, event_name = [], "message"
        elif line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
        elif line.startswith("event:"):
            event_name = line[6:].strip()
    if data:
        yield event_name, "\n".join(data)
