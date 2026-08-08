# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in vectra-js, please report it privately rather than opening a public GitHub issue.

Email: astroabhi.abhi@gmail.com

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal example is ideal)
- The version of vectra-js affected

We aim to acknowledge reports within 5 business days. Once a fix is available, we'll coordinate on a disclosure timeline with you before making details public.

## Supported Versions

Only the latest published version on npm receives security fixes.

## Scope

This SDK orchestrates calls to external vector databases and LLM providers that you configure and supply credentials for — it does not host or store your data itself. Vulnerabilities in this repo's own code (e.g. SQL construction, input validation, dependency issues) are in scope. Misconfiguration of the external services you connect it to is not.
