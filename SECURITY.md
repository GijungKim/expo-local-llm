# Security

## IMPORTANT

We do not accept AI-generated security reports. If you submit one, it will be ignored.

## Threat Model

expo-local-llm runs LLM inference entirely on-device. No user data leaves the device through this module — prompts and responses stay local. This module does not operate a backend, and there is no automatic cloud fallback.

The underlying model runtimes are separate vendor SDKs (Apple Foundation Models, Google ML Kit / AICore). They are governed by their own terms and may perform their own diagnostics independently of this module. Verify each vendor's current documentation before making privacy claims about your app.

### Out of Scope

| Category | Rationale |
|----------|-----------|
| **LLM output content** | On-device models may produce inaccurate or inappropriate content; this is inherent to LLMs, not a vulnerability in this module |
| **Apple Intelligence / Gemini Nano behavior** | Model behavior is controlled by Apple/Google, not this module |
| **MCP server interactions** | Not supported in this module |
| **App-level data handling** | How the consuming app stores or transmits LLM responses is outside our scope |

## Reporting Security Issues

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/GijungKim/expo-local-llm/security/advisories/new) tab.

We will send a response indicating the next steps in handling your report. After the initial reply, we will keep you informed of progress towards a fix.

If you do not receive an acknowledgement within 7 business days, open a regular issue referencing your report.
