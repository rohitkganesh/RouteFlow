---
name: login-form-error-mapping
description: "LoginForm.tsx used to map any error without a `code` field to `'Invalid email or password'`, so a real network/CORS/TypeError would show the same message as a legitimate auth failure — fixed to mirror the more thorough fallback in register/page.tsx"
metadata:
  type: project
---

# LoginForm error mapping was lying to users

`routeflow-frontend/src/app/auth/login/LoginForm.tsx` had a catch-block
fallback (old lines 135-137) that read:

```ts
} else {
  message = err instanceof Error ? err.message : 'Invalid email or password';
}
```

The `else` fired for **any** error that lacked a `code` field. That meant
if the axios call blew up for a reason unrelated to the password — a
network error that didn't go through `normalizeError`, a `TypeError`
from a malformed `response.data.data`, a CORS preflight failure, etc.
— the user would see "Invalid email or password" anyway. So a user
trying valid creds against a temporarily-down backend saw the same
message as someone who typed a genuinely wrong password, and the
"create route" report ("login page says username password mistake for
both correct and incorrect inputs") was a direct consequence: the user
couldn't tell which one was happening.

**Fix:** the catch block now mirrors the more thorough fallback in
`routeflow-frontend/src/app/auth/register/page.tsx` (lines 218-255).
"Invalid email or password" is now shown **only** when the error code
is `UNAUTHORIZED` or `INVALID_CREDENTIALS`. Anything else falls
through to:
- a backend-message verbatim (for known `VALIDATION_ERROR` /
  unknown-code cases)
- the actual `Error.message` (for `TypeError` etc.)
- a clear "Sign-in failed. Please try again — if the problem
  persists, check the browser console for details." (when the error
  is an empty object / non-stringifiable)

**Why:** the form's old fallback conflated *auth* failure with
*transport* failure. The register page was already doing the right
thing; the login page was an oversight. With the fix, when the user
sees "Invalid email or password" they can be confident the password
was actually wrong — not just that the page couldn't reach the
backend.

**How to apply:** any future form that calls `useAuth().login()` and
catches the result should follow the same code → message mapping.
Don't add a fallback that says "Invalid email or password" without
checking the error code first — that single line was the entire bug.
