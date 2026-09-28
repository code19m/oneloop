# Limits

This page lists the fixed limits built into oneloop, so you know what to expect
before you hit one.

Only the two storage settings can be changed, through
[configuration](configuration.md). Everything else is part of the release.

| Area | Limit | Value |
| --- | --- | --- |
| **Files** | Attachment size | 25 MiB per file |
| | Attachments per task | 25 |
| | Text and Markdown previews | First 200 KB; download the file for the rest |
| | HTML previews | Files up to 1 MiB |
| | Avatar | 5 MiB and at most 8192 px per side; stored as 256 × 256 px |
| | An upload in progress | Fails if it stalls for 60 seconds or takes over an hour |
| **Storage** | Space for stored files (`ONELOOP_STORAGE_LIMIT`) | 10 GiB by default; uploads beyond it are refused |
| | Free disk space to keep (`ONELOOP_DISK_MIN_FREE`) | 1 GiB by default; uploads that would go below it are refused |
| | Temporary attachments | Removed when storage reaches 80% of the limit, until it is back at 70%; files opened in the last 24 hours are kept |
| **Text** | Project name | 60 characters |
| | Task prefix | 2 to 4 uppercase letters or digits, never reused |
| | Track name | 60 characters; description 2,000 |
| | Epic title | 120 characters; description 2,000 |
| | Milestone title | 60 characters; description 500 |
| | Task title | 140 characters; description 4,000 |
| | Pool item title | 140 characters; description 2,000 |
| | Block reason | 500 characters; unblock note 500 |
| | Comment or reply | 2,000 characters |
| **Accounts** | Username | 3 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit |
| | Full name | 80 characters |
| | Password | At least 5 characters |
| | Signed-in sessions per account | 10; sign out of one to sign in somewhere new |
| | Session length | Ends after 7 days without use, and after 30 days at most |
| | Sensitive admin actions | Need a sign-in within the last 30 minutes |
| | Failed sign-ins | After 5 failures for one account from one address within 15 minutes, you wait 30 seconds, doubling up to 15 minutes |
| **Collaboration** | `@everyone` | Once per minute per person in each project |
| | Archived Inbox items | Deleted after 90 days |
| | Activity grouping | Edits by one person to the same field within 5 minutes show as one entry |
| | Activity history | Kept for good |
| **AI assistants** | Connected app | Ends after 30 days unused, and after 90 days at most |
| | App registrations | 10 per hour from one address; 300 per hour for the instance |
| | File transfer tickets | Single use; expire after 5 minutes |
| | Items per page | 50 (100 for comments, activity and the Inbox) |
| **Server** | Open connections | 1,024 |
| | Request headers | Must arrive within 15 seconds |
| | Request body | 256 KiB for ordinary requests; 1 MiB for MCP calls |
| | Busy database | A request waits up to 5 seconds, then gets "try again" |
| | Shutdown | Open requests get up to 30 seconds to finish |
| | Retry keys | Remembered for 24 hours |

Character limits count characters as JavaScript does (UTF-16 code units), so
some emoji count as two.
