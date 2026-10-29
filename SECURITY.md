# Security and privacy

PDFs are untrusted input. Parsing and rendering run in a dedicated worker. The application has no document-upload backend, telemetry, authentication, or third-party analytics. External PDF links must never open without explicit user action.

The only feature that sends anything off the device is the optional AI assistant in the web version. It is off by default; it sends the extracted text of the pages the user picks, and only to the API address shown in its consent checkbox (Anthropic unless the user enters another https address), after the user presses Send. The user's API key is kept in memory, or in local storage only if they choose "Remember". Document text is passed to the model as untrusted content. The Android app has no internet permission, so the assistant is unavailable there.

Report vulnerabilities privately through GitHub Security Advisories. Do not attach sensitive PDFs.
