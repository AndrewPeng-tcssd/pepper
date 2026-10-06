# Pepper TCG

A private development version of the pepper trading card game website. Accounts, hourly token claims, balances, and chat work now. Card artwork, packs, and paid token bundles are placeholders until those details are ready.

## Run it locally

1. Install [Node.js](https://nodejs.org/) version 20 or newer.
2. Run `npm install` in this folder.
3. Create a file named `.env` in this folder and add your MongoDB connection:

   ```text
   MONGODB_URI=mongodb+srv://your-connection-string
   MONGODB_DB=pepper_tcg
   ```

   Keep the real connection string private. `.env` is excluded by `.gitignore`.
4. Run `npm start`, then open `http://localhost:3000` in Chrome. Use `/profile` for the hourly token claim and `/packs/test` for the pack animation test. Opening `public/index.html` directly from the folder can display the page, but accounts, tokens, and chat need the running server.

## Accounts

New accounts use a username and password. No email address or email verification is needed, and sign-up logs you in immediately. Existing accounts keep their balances and can log in with their usernames and passwords. Existing accounts that already have an email can still use email login when email delivery is configured; that route sends a one-use verification link. Set `EMAIL_SENDING_PAUSED=true` to pause email login without affecting username login or new sign-ups. There is currently no password recovery, so keep your password safe.

The site stores accounts, password hashes, balances, claim times, and sessions in MongoDB. Passwords need at least eight characters. To change the local website port, set `PORT` before starting the server.

Change your username or password at `/settings` using your current password. Changing your username also updates the name shown on your chat messages. Changing your password signs out your other sessions while keeping the current session signed in.

Read release notes at `/changelog`. The original account named `675` can publish a title, description, and version from that page, and delete changelog entries. Publishing dates are set by the server and displayed in each reader's local timezone. The latest remaining entry sets the development build version in the site footer; deleting that entry restores the previous entry's version, and an empty changelog uses `0.4.0`. Versions use `major.minor.patch`, such as `0.5.0`, and may include a leading `v` when entered.

Every account has a permanent random account ID, such as `PPR-8F0B6ED0-77F5-4E25-9B41-B75B1EE16791`. New accounts receive their IDs on registration, and existing accounts receive them automatically when the server starts. IDs are saved uniquely in MongoDB and stay the same through username or password changes and server restarts. They appear in account details and public profiles.

The changelog owner can choose **View as visitor** to hide the entry form and delete controls, then **Back to editing** to return without losing a draft. Deleting an entry asks for confirmation first.

Changelog publishing permission is saved against the owner's permanent random account ID in MongoDB. Existing ownership automatically migrates from the original stored MongoDB account to its random ID. Changing that account's username keeps the permission; another account that later takes the name `675` does not receive it. If the owner has not registered yet, changing an existing account's username to `675` is reserved.

Read site news at `/announcements`. The same permanent changelog owner can publish announcements with a title and description, preview them as a visitor, and delete them with confirmation. Everyone can read them. Announcements are saved in MongoDB with automatic publishing dates and do not change the development build version.

The live player count above chat shows unique signed-in players with an open site page. Pages refresh the count and their activity every 20 seconds. Multiple tabs or devices count once per account, signed-out sessions stop counting immediately, and closed or disconnected pages age out after 75 seconds without activity. Guests can read the count without being counted.

## Cloudflare verification

The hourly token claim uses Cloudflare Turnstile. On `localhost` in a non-production run, the site uses [Cloudflare's test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) so you can test the claim flow without creating a Cloudflare account. For any deployed site, create a Turnstile widget for that hostname and set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in `.env`. Keep the secret key private. The server verifies each token with Cloudflare before adding tokens. Test keys must not be used for a deployed site.

## Existing local account

The previous version kept accounts in `data/pepper.sqlite`. After adding `MONGODB_URI`, run `npm run migrate` once to copy existing accounts, password hashes, balances, and last claim times to MongoDB. The command leaves the SQLite file in place as a backup and skips accounts already migrated. Users then log in again.

## What works now

- Username and password sign-up and login; sign out. Existing email logins remain available for accounts that already have an email. Passwords are salted and hashed.
- Account details, username and password changes, and appearance settings at `/settings`, with light or dark mode saved per browser.
- Persistent MongoDB account balances.
- Public changelog entries saved in MongoDB, with publishing and deletion restricted to the original `675` account and an automatic footer version.
- Public announcements styled like changelog entries, with publishing and deletion restricted to the same permanent owner.
- A live count of unique signed-in players, shared across server instances and updated automatically above chat.
- Click a username in chat to view that member's public profile, including their username, join date, token balance, and last and next claim details. Clicking your own username opens `/profile`, your account and token claim page. Other public profiles also open directly at `/profile/USERNAME`.
- Cloudflare Turnstile verification and a random reward of 10–20 tokens once every rolling hour per account. Each whole-number reward is chosen on the server, and MongoDB adds it with an atomic update that also enforces the claim timer.
- A shared public chat in a fixed left sidebar on desktop and a left-side panel on narrow screens. Everyone can read the latest 50 messages; signed-in users can post. Messages are saved in MongoDB. Posting has length and speed limits.
- A pack opening animation test at `/packs/test`. It reveals five blank cards and can be reset. It does not use tokens or save cards.

The planned pack price shown on the site is a placeholder. There is currently no pack or payment checkout.

## Before a public launch

Run behind HTTPS, configure real Cloudflare Turnstile keys, and add password recovery and chat moderation before accepting public users. Review privacy and payment requirements before accepting real users or payments. Back up MongoDB regularly once people use the site.

Run the automated account and claim check with `npm test`.
