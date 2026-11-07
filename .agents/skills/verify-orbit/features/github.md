# GitHub

This recipe checks the GitHub token, the connection check, and a read-only issue card in Chrome. It uses the local model fixture and a local MCP fixture. It does not call GitHub.

## Run

From the repo root, run these commands after `npm run build`.

```sh
node .agents/skills/verify-orbit/verify.mjs launch --mock
node .agents/skills/verify-orbit/verify.mjs doctor
node .agents/skills/verify-orbit/verify.mjs browse github
node .agents/skills/verify-orbit/verify.mjs cleanup
```

The scenario owns its mock MCP server and closes it even if a check fails. It saves a fake token and checks that the API never returns it. Launch sets `ORBIT_GITHUB_MCP_FIXTURE=1` on the verify server so that server can send the fake token to the local fixture. A normal server leaves the variable unset and refuses that URL. The model URL defaults to `http://127.0.0.1:3299/v1`. Set `ORBIT_QA_PROVIDER` when that port is already taken.

## Proof

Require each printed check to pass.

- Settings save reports `githubTokenSet` and the MCP URL, and the response has no token.
- A wrong token shows `GitHub rejected the token.`
- Check with the stored token shows Connected and the login `octocat`, then closes the MCP client.
- `[qa:github]` starts one `github_list_issues` card and changes it to Succeeded.
- The card and the answer link to `https://github.com/aduthekaddu/orbit/issues/7` with `Migration lock`.
- The link uses `target="_blank"` and `rel="noopener noreferrer nofollow"`.
- The issue body is not rendered.
- The card and its link survive reload.
- The card fits at 390 by 844 without page overflow.
- The chat closes the MCP client.

Screenshots land in `.verify/evidence/github/`. They are `connected.png`, `issues.png`, and `mobile.png`.

A real fine-grained read-only token can repeat Check and the question "List the open issues in aduthekaddu/orbit." Keep the token out of the output. That run is not part of CI.
