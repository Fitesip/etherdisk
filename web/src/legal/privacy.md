# Etherdisk Privacy Policy

*Draft — to be reviewed by a lawyer before publication.*
Effective date: [DATE]

This policy explains what Etherdisk (etherdisk.app), operated by [OPERATOR NAME] ("we"), can see and keep. In short: **we can't read your files**, we have no accounts, emails or names, and we use no analytics or advertising trackers.

## 1. What we can't see

Files are encrypted in your browser before upload. We never receive:

- the contents, names or types of your files and folders;
- your passphrase, your recovery key or your drive's encryption key;
- the keys in your share links (they stay in the part of the link after `#`, which browsers don't send to servers).

## 2. What we process

| Data | Why | How long |
| --- | --- | --- |
| **Wallet addresses** | Sign-in, knowing which drives you hold, ideas and votes, key handover | As long as the related drive, idea or vote exists |
| **Sign-in sessions** (a random token, stored hashed, with its wallet and expiry) | Keeping you signed in | Until it expires ([7] days) or you sign out |
| **Encrypted files and their metadata**: size, number of files, folder structure (without names), dates, trash state | Storing and serving your files | Until you delete them, format the drive, or the service ends |
| **Drive name and colors** you choose (not encrypted, so the drive list can show them while locked) | Showing your drives | Until you change them or format the drive |
| **Share links**: which drive, when created, expiry, an encrypted list of the shared files | Serving shared files | Until the link expires, is revoked, or the drive changes hands |
| **Key handover data**: your inbox public key and its wallet signature, drive keys sealed for a recipient | Handing a drive's key to its next holder | Until the handover is completed or cancelled |
| **Recovery data**: your drive key encrypted under your recovery words | Opening the drive if you forget the passphrase | Until you remove it, the drive changes hands, or is formatted |
| **Ideas and votes**, with the wallet signatures behind votes | The ideas board | Public; until removed by moderators |
| **IP addresses** | Protecting the service from abuse (rate limits) | In memory only, for a few minutes; **not written to our logs** (only critical server errors may record one, kept up to [N] days) |

We don't ask for or keep your name, email, phone number or payment card. Payments are made in ETH on the blockchain.

## 3. Public by nature

The blockchain is public. Anyone can see which wallet holds which drive, when it was minted and transferred, and what was paid. Ideas, votes and their signatures on the ideas board are public too. We can't delete information from the blockchain.

## 4. On your device

The site keeps, in your browser: your sign-in session and settings (view, sort order, auto-lock) in local storage, and — only if you turn on "stay unlocked after reloading" — your drive key encrypted with a key that can't be read out of the browser, for the current tab. We use no cookies for tracking.

## 5. Services the site talks to directly

Your browser connects directly to:

- **Ethereum RPC providers** ([publicnode.com], [tenderly.co]) to read the blockchain;
- **WalletConnect / Reown**, if you connect a mobile wallet that way;
- your **wallet** software.

They see your IP address and the requests they handle, under their own privacy policies. We don't share your data with anyone else, and we don't sell it.

## 6. Requests from authorities

If we receive a lawful order, we can only provide what we have: the data in section 2. We can't decrypt files.

## 7. Your choices and rights

- You can delete files, revoke links, remove a recovery key or format a drive at any time; this removes the related data from our servers (backups, if any, roll over within [N] days).
- You can ask what we hold about your wallet, or ask us to delete it, at [CONTACT EMAIL]. To prove a wallet is yours, we may ask you to sign a message with it.
- Depending on where you live (for example under the GDPR), you may have further rights, such as to complain to a data protection authority.

## 8. Security

Encryption happens on your device with modern algorithms (XChaCha20-Poly1305, Argon2id); the server stores ciphertext on redundant disks and serves the site over HTTPS. No system is perfectly secure: keep your recovery key safe and your own copies of important files.

## 9. Children

Etherdisk is not meant for children under [16].

## 10. Changes and contact

We'll post changes to this policy on the site with a new effective date.
Data controller: [OPERATOR NAME], [ADDRESS]. Contact: [CONTACT EMAIL]
