# Onla Twenty fork

This fork is prepared for the Onla built-in CRM path.

Initial integration contract:

- raw public signup stays closed;
- Onla provisions customer workspaces through `POST /onla/bootstrap/workspace`;
- the endpoint accepts `Authorization: Bearer <ONLA_BOOTSTRAP_SHARED_SECRET>`;
- Onla-created workspaces/users default to `ru-RU`;
- customer-facing branding should read `Onla CRM` while preserving required upstream license notices;
- provisioning must be idempotent by `onla_client_id`.

See the main Onla repo: `references/onla-twenty-fork.md`.
