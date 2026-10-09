# Pepper TCG

A private development version of the pepper trading card game website. Accounts, hourly token claims, balances, private trading sessions, and chat work now. Card artwork, packs, and paid token bundles are placeholders until those details are ready.

## Run it locally

1. Install [Node.js](https://nodejs.org/) version 20 or newer.
2. Run `npm install` in this folder.
3. Create a file named `.env` in this folder and add your MongoDB connection:

   ```text
   MONGODB_URI=mongodb+srv://your-connection-string
   MONGODB_DB=pepper_tcg
   ```

   Use MongoDB Atlas or a MongoDB replica set so confirmed trades and account deletion can update related records in one transaction. A standalone MongoDB server can store requests, but confirmations and account deletion require a replica set. Keep the real connection string private. `.env` is excluded by `.gitignore`.
4. Run `npm start`, then open `http://localhost:3000` in Chrome. Use `/profile` for the hourly token claim and Overview (`/`) for the pack animation test. The Packs page at `/packs` shows “Coming soon.” Opening `public/index.html` directly from the folder can display the page, but accounts, tokens, and chat need the running server.

## Accounts

New accounts use a username and password. No email address or email verification is needed, and sign-up logs you in immediately. Existing accounts keep their balances and can log in with their usernames and passwords. Existing accounts that already have an email can still use email login when email delivery is configured; that route sends a one-use verification link. Set `EMAIL_SENDING_PAUSED=true` to pause email login without affecting username login or new sign-ups. There is currently no password recovery, so keep your password safe.

The site stores accounts, password hashes, balances, claim times, and sessions in MongoDB. Passwords need at least eight characters. To change the local website port, set `PORT` before starting the server.

Change your username or password at `/settings` using your current password. Changing your username also updates the name shown on your chat messages. Changing your password signs out your other sessions while keeping the current session signed in.

Profile pictures default to a pepper and appear beside usernames in public and private chat, profiles, and the online-player list. Upload a PNG, JPEG, or WebP up to 2 MiB in Settings, or choose **Use default**. Uploaded pictures are resized to 256×256 WebP and stripped of metadata.

Settings also includes permanent account deletion, requiring the current password and typing `DELETE`. Deletion signs out every session, removes the account, its owned cards, verification links, and public messages, and cancels active trades. Shared trade history remains available to the other player under **Deleted player**; the deleted player's private messages and quoted public messages become **Message deleted**.

Read release notes at `/changelog`. The original account named `675` can publish a title, description, and version from that page, and delete changelog entries. Publishing dates are set by the server and displayed in each reader's local timezone. The latest remaining entry sets the development build version in the site footer; deleting that entry restores the previous entry's version, and an empty changelog uses `0.4.0`. Versions use `major.minor.patch`, such as `0.5.0`, and may include a leading `v` when entered.

Every account has a permanent random account ID, such as `PPR-8F0B6ED0-77F5-4E25-9B41-B75B1EE16791`. New accounts receive their IDs on registration, and existing accounts receive them automatically when the server starts. IDs are saved uniquely in MongoDB and stay the same through username or password changes and server restarts. They appear in account details and public profiles.

The changelog owner can choose **View as visitor** to hide the entry form and delete controls, then **Back to editing** to return without losing a draft. Deleting an entry asks for confirmation first.

Changelog publishing permission is saved against the owner's permanent random account ID in MongoDB. Existing ownership automatically migrates from the original stored MongoDB account to its random ID. Changing that account's username keeps the permission; another account that later takes the name `675` does not receive it. If the owner has not registered yet, changing an existing account's username to `675` is reserved.

Read site news at `/announcements`. The same permanent changelog owner can publish announcements with a title and description, preview them as a visitor, and delete them with confirmation. Everyone can read them. Announcements are saved in MongoDB with automatic publishing dates and do not change the development build version.

The live player count above chat shows unique signed-in players with an open site page. Clicking it opens a list of online players with their pictures and profile links. Pages refresh the count and their activity every 20 seconds. Multiple tabs or devices count once per account, signed-out sessions stop counting immediately, and closed or disconnected pages age out after 75 seconds without activity. Guests can read the count without being counted.

Select **Reply** on a chat message to quote it in your next message. You can cancel the reply while keeping your draft. Reply quotes keep the original message text after older messages leave the chat history, and follow the author's current username. Select an available quote to jump to the original message.

Your own messages appear immediately while the server saves them. Other players receive the saved message on the next chat update. Failed sends show a retry option; retrying the same message does not create a duplicate if it was already saved.

Moving between the site's pages keeps chat open, with the same messages, draft, reply selection, and scroll position. Navigation updates the main page without reloading the site; browser Back and Forward work too. Opening a new tab or manually refreshing still starts a new page.

The public `/leaderboard` page ranks the top 100 players by their current token balance. Equal balances share a rank and appear alphabetically. It updates every 15 seconds while open, and each player links to their profile.

## Trading

At `/trading`, enter a player's username and send a request with one click. Requests use their permanent account ID internally. Incoming requests appear in a bottom-right popup across the site; accepting opens the trade session. The recipient can also accept or decline from Trading. Tokens and cards become visible after the request is accepted. Each player then chooses only their own contribution, and both players can talk in the session's private chat.

Your offered tokens and cards appear on the left, and the other player's appear on the right, including on narrow screens. Your selections preview immediately and show **Unsaved changes** until saved. Starting a trade from someone's profile opens the request form for that player, even if you previously viewed another session.

Both players must confirm the same current contributions before anything moves. Changing either contribution clears both confirmations, so each player reviews the new terms. Trades can exchange cards, tokens, or both, including gifts, and each side may include up to 50 cards. Separate copies of the same card are separate inventory items. Both sides cannot be empty when confirming.

Requests and contribution changes do not reserve or move assets. The second confirmation checks both balances, card ownership, and tradability, then transfers everything together. If a player cannot afford their part or a card is no longer available, nothing moves. Either player can cancel a pending or joined session. Repeating a completed confirmation does not transfer assets again.

Only the two players can view a session and its chat. The Trading page shows all active sessions and the latest 100 completed sessions. Private chat shows the latest 100 messages in order and remains readable after closing a session. Sessions, messages, and completed trades stay saved through server restarts and follow each player's current username. Retrying a message does not create a duplicate.

Card trading uses catalog definitions and uniquely owned card copies saved in MongoDB. Inventory lists actual tradable copies, and contributions retain the card descriptions shown when selected. The framework does not issue demo cards to players. Packs still show “Coming soon,” and the animation test does not grant cards. Real pack issuance and purchases remain to be implemented.

Existing pending offers become trade requests. Their sender's saved contribution stays hidden until the request is accepted, and the recipient then chooses their own contribution. Completed trade history stays intact.

For server-side rewards, `cards.js` exports `upsertCardDefinition(store, { id, name, rarity, setName, imageUrl })` and `grantCards(store, { ownerAccountId, cardIds, grantId })`. `cardIds` are catalog IDs; repeated IDs issue distinct copies. Use a fresh UUID for each reward's `grantId` and reuse it when retrying that reward. A retry returns the original copy IDs, even after those cards have been traded. Reusing a grant ID for another owner or different contents is rejected. Future pack code can pass `{ session }` as a third argument inside its active MongoDB transaction to combine payment and issuance. There is no public card-issuing endpoint.

## Cloudflare verification

The hourly token claim uses Cloudflare Turnstile. On `localhost` in a non-production run, the site uses [Cloudflare's test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) so you can test the claim flow without creating a Cloudflare account. For any deployed site, create a Turnstile widget for that hostname and set both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in `.env`. Keep the secret key private. The server verifies each token with Cloudflare before adding tokens. Test keys must not be used for a deployed site.

## Existing local account

The previous version kept accounts in `data/pepper.sqlite`. After adding `MONGODB_URI`, run `npm run migrate` once to copy existing accounts, password hashes, balances, and last claim times to MongoDB. The command leaves the SQLite file in place as a backup and skips accounts already migrated. Users then log in again.

## What works now

- Username and password sign-up and login; sign out. Existing email logins remain available for accounts that already have an email. Passwords are salted and hashed.
- Account details, username and password changes, picture uploads, permanent account deletion, and appearance settings at `/settings`, with light or dark mode saved per browser.
- Persistent MongoDB account balances.
- Private trading sessions with each player's own card and token selections, two confirmations, private chat, actual owned card inventories, cancellation, decline, saved history, and atomic transfers.
- Public changelog entries saved in MongoDB, with publishing and deletion restricted to the original `675` account and an automatic footer version.
- Public announcements styled like changelog entries, with publishing and deletion restricted to the same permanent owner.
- A clickable live count and list of unique signed-in players, shared across server instances and updated automatically above chat.
- Click a username in chat to view that member's public profile, including their username, join date, token balance, and last and next claim details. Clicking your own username opens `/profile`, your account and token claim page. Other public profiles also open directly at `/profile/USERNAME`.
- Cloudflare Turnstile verification and a random reward of 10–20 tokens once every rolling hour per account. Each whole-number reward is chosen on the server, and MongoDB adds it with an atomic update that also enforces the claim timer.
- A shared public chat in a fixed left sidebar on desktop and a left-side panel on narrow screens. Everyone can read the latest 100 messages; signed-in users can post and reply. Messages are saved in MongoDB. Posting has length and speed limits. Page navigation preserves the chat and drafts.
- A public token leaderboard with current balances, shared ranks for ties, and profile links.
- Overview shows your username, token balance, joined date, and last claim in a widget that links to your profile, beside the pack animation test.
- A pack opening animation test on Overview (`/`). It reveals five blank cards and can be reset. It does not use tokens or save cards. Old links to `/packs/test` redirect to the demo on Overview.

The Packs page at `/packs` currently displays “Coming soon.” There is currently no pack or payment checkout.

## Before a public launch

Run behind HTTPS, configure real Cloudflare Turnstile keys, and add password recovery and chat moderation before accepting public users. Review privacy and payment requirements before accepting real users or payments. Back up MongoDB regularly once people use the site.

Run the automated account, claim, and trading checks with `npm test`. The trading tests start isolated local MongoDB replica sets automatically and seed test cards only in their temporary databases.
