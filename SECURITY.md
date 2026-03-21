# Security

## IMPORTANT

We do not accept AI-generated security reports. If you submit one, it will be ignored.

## Threat Model

expo-local-llm runs LLM inference entirely on-device. No user data leaves the device through this module — prompts and responses stay local.

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
