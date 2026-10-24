# Security policy

Version 0.1.x is the initial supported line.

## Security model

`openapi-to-mcp` lets an AI agent call an HTTP API. The defaults are deliberately narrow:

- Only `GET` and `HEAD` operations become tools. `POST`, `PUT`, `PATCH` and `DELETE` need `--allow-write`, and are refused again at call time.
- The default allowed host is the base URL's host. Repeated `--allow-host` options replace that list; a host without a port allows all its ports. Redirects are never followed.
- Credentials come from environment variables (`--bearer-env`, `--header-env`). There is no flag that takes a secret value. Authorization, Cookie and configured environment headers are hidden from tool arguments. Configure custom authentication headers explicitly; `securitySchemes` are not automatically applied.
- Path values are percent-encoded, `.` and `..` are rejected, and header values with line breaks are rejected.
- Responses are capped (`--max-response`) and requests time out (`--timeout`).

Limits: the tool trusts the OpenAPI document you give it (only local `$ref` values are resolved) and the API you point it at. Anything the API returns is passed to the agent as text, so treat it as untrusted input. Request bodies are not validated against the schema beyond required arguments; the API must do that.

The allowlist does not enforce DNS/IP isolation. GET operations can have side effects. API responses are not redacted and may echo credentials. Generated manifests include API URLs and schema descriptions; review them before sharing. The generator refuses to overwrite existing output files.

## Reporting a vulnerability

Use **Report a vulnerability** under the repository's [Security tab](https://github.com/YusufBeratZengin/openapi-to-mcp/security) (GitHub private vulnerability reporting). The repository owner must enable it in the repository settings before the first public release. If the button is missing, open an issue asking for a private channel, without exploit details. Do not include credentials or personal data in any report. No response-time guarantee is offered.
