# Destination bot setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application or use your existing bot application.
2. Obtain the bot token from the bot settings. Keep it local; exclude it from screenshots and public issues.
3. Configure a server installation with the `bot` scope. Grant **View Channels**, **Manage Channels**, **Send Messages**, **Attach Files** and **Read Message History**. Administrator is not required.
4. Install the bot in the destination server using its install link. Your account must have permission to install it.
5. For reconciliation of arbitrary older messages, enable **Message Content Intent** when available. Discord gates message content and attachment fields; missing access can prevent reliable reconciliation. Applications subject to approval requirements need that access approved. This CLI uses REST rather than a Gateway connection.
6. Copy `.env.example` to `.env` in the project folder and fill in `DISCORD_BOT_TOKEN`.
7. Run `npm start`, choose `3`, select a small indexed batch and review the destination plan.

Type `STRUCTURE` when the displayed category and channels are correct. Press Enter at `MIGRATE` to inspect the saved reconciliation report without posting. A later run can upload verified missing items after the same checks.

For an existing destination category, paste a full URL for any accessible text channel inside it. For a category that does not exist, enter the destination **server ID**, then its intended name. Enable Developer Mode in Discord to copy IDs.

If Discord returns `Unknown Guild`, check that the number is a server ID rather than a category ID and that the bot is installed there. A channel URL avoids this mix-up.

Official references: [Message content access](https://docs.discord.com/developers/events/gateway#message-content-intent), [Channels](https://docs.discord.com/developers/resources/channel), [Messages](https://docs.discord.com/developers/resources/message).
