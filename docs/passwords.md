# Password storage

This guide covers how to store a sign-in password for Crontab UI without keeping the password itself in the environment.

## Why not store the password?

`BASIC_AUTH_USERS_JSON` holds a map of user names to passwords. A literal password is compared exactly as written, which means anyone who can read the process environment can read the password: `docker inspect`, a `.env` file that was committed by accident, a crash report, a support bundle. An environment variable is also a poor place for a long-lived secret, because it is trivially copied and there is no way to tell who read it.

Storing a digest instead removes the password from the environment. What remains is not a secret in the usual sense: it can only confirm whether a candidate password matches, and confirming that is deliberately expensive.

Note the terminology. This is hashing, not encryption. A digest is one-way: there is no key and no procedure that turns it back into the password. If you lose a digest, the password is gone and you generate a new one.

## Generate a digest

```bash
npx crontab-ui-hash
```

The command prompts for `Password:` without echoing the input, and prints the digest as JSON:

```
{"digest":"scrypt:46a133531b1fffd163823f0ffd0fe98b:93af5c75...e4168dd1"}
```

It also prints the configuration line to paste, with `your-user` as a placeholder that you replace with the actual user name.

The command also accepts a password as an argument for scripted setup, for example `npx crontab-ui-hash "$(cat /run/secrets/admin_password)"`. Do not use a literal argument: command arguments are visible to any process on the host. Prefer the interactive prompt or a read from a secret file.

The format is `scrypt:<salt>:<hash>`, with a 16-byte random salt generated per invocation. The same password therefore produces a different digest every time, and two users with the same password do not share a digest. Cost parameters are scrypt N=16384, r=8, p=1, with a 64-byte output.

## Configure it

Replace the password in the map with the digest:

```bash
BASIC_AUTH_USERS_JSON={"admin":"scrypt:46a133531b1fffd163823f0ffd0fe98b:93af5c75...e4168dd1"}
AUTHZ_ROLE_MAP_JSON={"admin":"admin"}
```

`AUTHZ_ROLE_MAP_JSON` does not change. Roles are assigned by user name and are independent of how the password is stored.

For several users, generate one digest per person and place them in the same value:

```bash
BASIC_AUTH_USERS_JSON={"admin":"scrypt:...","operator":"scrypt:..."}
AUTHZ_ROLE_MAP_JSON={"admin":"admin","operator":"operator"}
```

Every user in the password map must also appear in the role map, and every role must name a user that exists. Either mismatch stops the service from starting, naming the problem, rather than leaving an account that silently cannot sign in.

## Restart and verify

```bash
docker compose up -d
```

Sign in through the interface with the password. Two checks worth running once, on a non-production instance:

- The new password is accepted.
- The previous password is rejected.

```bash
docker compose exec crontab-ui curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/login
```

The sign-in page responds `200`. It is served without authentication, so this only confirms that the service is up and serving, not that the digest is correct.

## Change a password later

There is no recovery path. Generate a new digest and replace the value:

```bash
npx crontab-ui-hash
docker compose up -d
```

Store the new digest somewhere safe before restarting. A user locked out this way is recovered by generating another digest, not by looking anything up.

## Deployment notes

Keep `.env.production` out of version control. The repository `.gitignore` already excludes it, but verify that the file you deploy from is not tracked:

```bash
git check-ignore -v .env.production
```

Prefer a Docker secrets file over `environment:` in `docker-compose.yml`. A value passed through `environment:` appears in full in `docker inspect`, and in the output of `docker compose config`. A digest is far less damaging than a password in the same place, but neither belongs in a file that is copied around casually.

The service already supports a secrets file for this. Do not commit the digest alongside the Compose file, and do not paste it into an issue tracker.

## What the digest does and does not protect

It removes the password from the environment. It does not protect against an attacker who can already read the configuration and has the digest to work with, nor against brute force at the sign-in form itself. Those are handled elsewhere: the login route is rate limited, the response for an unknown user performs the same work as for a wrong password so timing does not disclose which accounts exist, and sessions are signed with `AUTH_SESSION_SECRET`, falling back to `CSRF_SECRET`.

Set a dedicated `AUTH_SESSION_SECRET` so that session signing can be rotated independently of the CSRF secret.

## Troubleshooting

**`BASIC_AUTH_USERS_JSON contains a malformed password digest for user <name>`**

A value beginning with `scrypt:` is not a well formed digest. Usually a truncated paste, a line break inside the value, or quotes mangled by shell interpolation. Generate a fresh digest. The service stops on purpose rather than accepting a configuration that could not possibly authenticate.

**Every sign-in returns 401**

Check the digest was pasted in full; a partial value is malformed and would have been rejected at startup, so this usually means the password is simply not the one that produced the stored digest. There is no way to confirm which password a digest came from, by design.

**A password generated by another tool does not work**

Only the `scrypt:` format is recognised. A bcrypt or Argon2 hash from another system is treated as a literal password and compared as text, so the account cannot sign in. This case is not detected at startup, which is a known gap: a value that looks like a hash but uses another algorithm is not rejected. Generate the digest with `crontab-ui-hash` instead.

**`Authenticated user <name> has no assigned role`**

The user is in the password map but not in `AUTHZ_ROLE_MAP_JSON`, or the role name is not one of `viewer`, `executor`, `operator`, `admin`.

**Sign-in works but the user cannot see a task**

Unrelated to password storage. A non-administrator sees only their own tasks, and tasks with no owner are visible to administrators only. The role is the name in `AUTHZ_ROLE_MAP_JSON`, not the user name: a user called `admin` with the role `viewer` is a viewer.

## Reference

| Item | Value |
| --- | --- |
| Digest format | `scrypt:<salt-hex>:<hash-hex>` |
| Parameters | N=16384, r=8, p=1, 64-byte output, 16-byte salt |
| Generator | `npx crontab-ui-hash` |
| Configuration | `BASIC_AUTH_USERS_JSON` |
| Roles | `AUTHZ_ROLE_MAP_JSON`, unchanged by hashing |
| Literal passwords | Supported, constant time, development only |
