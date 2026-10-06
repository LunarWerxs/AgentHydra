"""Safe, machine-readable errors shared by the CLI and HTTP transport."""


class ClaudeError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "operation_failed",
        status: int | None = None,
        chat_id: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.chat_id = chat_id
        self.retryable = retryable

    def as_dict(self) -> dict:
        result = {"code": self.code, "message": str(self), "retryable": self.retryable}
        if self.status is not None:
            result["http_status"] = self.status
        if self.chat_id:
            result["chat_id"] = self.chat_id
        return result
