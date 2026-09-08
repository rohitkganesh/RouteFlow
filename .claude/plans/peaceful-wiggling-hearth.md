# Notification bell + dropdown on all logged-in pages

## Context

The user asked for a notification UI: a bell icon with a dropdown showing recent notifications, a real-time-feeling badge, and the ability to mark items read. The bell needs to appear on every authenticated page (seller, driver, admin).

**What's already there** — and this is why the scope is small:

- **All three role layouts already render a `BellIcon` button** in the top header (`SellerDashboardLayout.tsx:133-139`, `DriverDashboardLayout.tsx:228-234`, `AdminPanelLayout.tsx:174-180`). Each currently shows a hardcoded red dot and does nothing on click. We're replacing those, not adding new chrome.
- **The backend already pushes `notification:new` events to `user:${userId}` rooms** (`src/socket/index.ts:148` joins the room, `:392` emits the event). The socket event shape is `{ id, userId, type, title, body, data, createdAt }` (see `NotificationEvent` interface at `src/socket/index.ts:382-389`).
- **The frontend `ApiClient` already has the REST endpoints** for fetching/marking notifications: `getNotifications()`, `markNotificationRead(id)`, `markAllNotificationsRead()` (see `src/lib/api.ts:631-643`).
- **The `Notification` DB-row type is already defined** in `src/types/index.ts:517-535` (uses `message`); the socket event payload uses `body`. Both need to be handled.
- **The `SocketProvider` is already mounted at the root** (`src/app/layout.tsx:5,50`) and already runs token-refresh-aware connect/reconnect logic (`src/lib/socket.tsx`). It exposes `socket`, `isConnected`, and event-specific React state via context.

**What's missing** — the only new code is the bell UI, the socket subscription, and a small store to feed the badge count + dropdown list across components. No backend work, no API client changes, no layout-shell rewrites.

## Design

A single `NotificationBell` component replaces the dead bell button in each of the three role layouts. It owns:

1. A local notification store (zustand) — shared across the three instances on the same page (there can only be one, but the store is mounted once).
2. An initial REST fetch of the most recent notifications on mount.
3. A socket subscription to `notification:new` that prepends new items and bumps the unread count.
4. A dropdown panel with: scrollable list of recent items, "Mark all read" footer, and a "View all" link (placeholder for now — a future full notifications page).
5. Click-outside / Escape to close. Mobile-friendly (works down to 320px).

## Files

### New

- `routeflow-frontend/src/stores/notifications.ts` — zustand store: `items: Notification[]`, `unreadCount: number`, `isOpen: boolean`, plus `setOpen`, `addOne`, `markRead(id)`, `markAllRead`, `hydrate`, `reset`. Pure state; no socket calls here. Keeps the bell component a thin shell.
- `routeflow-frontend/src/components/notifications/NotificationBell.tsx` — the bell + dropdown. Imports the store, mounts the socket subscription, renders the icon button + dropdown panel. The `BellIcon` SVG already exists inside each layout — we can reuse the same path, no need to import from `@heroicons` (the project already has `@heroicons/react` available per `package.json`, so use `BellIcon` from `@heroicons/react/24/outline` for consistency with `Toaster.tsx`).
- `routeflow-frontend/src/components/notifications/NotificationItem.tsx` — single row in the dropdown list. Title, body, relative time (`date-fns/formatDistanceToNow` — `date-fns` is already a dep), unread dot, click-to-mark-read.

### Modified

- `routeflow-frontend/src/components/layouts/SellerDashboardLayout.tsx` — replace the dead bell button (lines 133-139) with `<NotificationBell />`. Remove the local `BellIcon` SVG component (line 298-304) since it becomes unused; keep the other icon components.
- `routeflow-frontend/src/components/layouts/DriverDashboardLayout.tsx` — same: replace lines 228-234 with `<NotificationBell />`. Remove the local `BellIcon` SVG (lines 437-443).
- `routeflow-frontend/src/components/layouts/AdminPanelLayout.tsx` — same: replace lines 174-180 with `<NotificationBell />`. Remove the local `BellIcon` SVG (lines 358-364).
- `routeflow-frontend/src/lib/socket.tsx` — add a `notification:new` event listener in the existing `newSocket.on(...)` block (around line 318). Use the existing `NotificationEvent` shape from `src/socket/index.ts:382-389`. Forward the new event into the notifications store via a `useNotificationsStore.getState().addOne(payload)` call. Also extend the `SocketContextType` to expose a `lastNotification: NotificationEvent | null` so non-bell consumers (e.g. the existing Toaster) can show a toast on receipt. Keep this client-side, no backend change.

## Why these design choices

- **One store, three consumers (one per layout)**: zustand is already in `package.json` and the project uses it elsewhere. A single store avoids passing the list through the `SocketProvider` context and keeps the bell's network state close to its UI. The store is the source of truth; the socket is just a producer that writes into it.
- **Reuse the existing `notification:new` event instead of polling**: the backend already pushes. Subscribing in the socket layer means one connection, no extra HTTP, and works across all three roles since each user is in their own `user:${id}` room. Falls back to REST on initial load to populate the dropdown for users who logged in before any new event arrived.
- **`date-fns` for "2m ago"**: dep is already in `package.json`. `formatDistanceToNowStrict` is the right primitive — drops the "about" and is concise.
- **No new dependency on `@heroicons`**: project already has it. We use `BellIcon` and `XMarkIcon` (already used in `Toaster.tsx`) from `@heroicons/react/24/outline`.
- **Keep the dropdown scope small**: list 5-7 most recent, "Mark all read" + "View all" footer. A dedicated `/notifications` page is out of scope; the "View all" link points to `/seller/notifications` / `/driver/notifications` / `/admin/notifications` (404 today — that's fine, it's a stub) and we can build the full page later if asked.

## Edge cases handled

- **No socket connection** (token missing, network down): bell still shows the count from the initial REST fetch and a tooltip "Live updates unavailable". No infinite reconnect.
- **Token expired mid-session**: `SocketProvider` already handles refresh + permanent disconnect; we just stop receiving `notification:new`. The REST-fetched list is still readable.
- **Logout / role switch**: the store needs to be cleared on logout so the next user doesn't see the previous user's notifications. Add a `useEffect` in `NotificationBell` (or a top-level effect in the existing `AuthProvider` consumer tree) that calls `notificationsStore.reset()` when `accessToken` becomes null. Wire it into the bell component since that's the only consumer — no need to touch `auth.tsx`.
- **Hydration mismatch**: the badge count comes from a network call, so the SSR-rendered HTML has `unreadCount = 0` and the count pops in after mount. Mirror the `mounted` pattern already used in `DriverDashboardLayout.tsx:39` to avoid a flash of "0 → 3".
- **Click outside**: use a small `useEffect` that listens for `mousedown` on `document` and closes the dropdown when the click target isn't inside the bell's wrapper. Same pattern as the user-menu in `SellerDashboardLayout.tsx:163-167`.
- **Multiple layouts mounted at once** (e.g. during role-switch testing): only one role's layout renders at a time (the route guard enforces this), so the single store is fine. No race.
- **Notification body is empty**: some events have only a title. Render a single line.
- **`data` field routing**: the backend embeds `{ orderId, routeId, ... }` in `data`. We use this to make each row a `<Link>` to the relevant order/route detail page. Falls back to a non-clickable row if no `data`.

## Reuse summary

- `apiClient.getNotifications` / `markNotificationRead` / `markAllNotificationsRead` — `src/lib/api.ts:631-643`
- `SocketProvider` connect/reconnect logic — `src/lib/socket.tsx:172-328`
- `useAuth` for logout-detection — `src/lib/auth.tsx`
- `formatDistanceToNowStrict` from `date-fns` (already a dep)
- `BellIcon`, `XMarkIcon` from `@heroicons/react/24/outline` (already a dep, used in `Toaster.tsx`)
- `Notification` type — `src/types/index.ts:517`

## Out of scope

- Full `/notifications` page with filters and pagination.
- Push-notification (browser Web Push) — would need a service worker; not requested.
- Re-firing `notification:new` for users who reconnect after offline (backend would need to replay missed events). The bell shows whatever the REST fetch returns on mount; live events since reconnect are real-time.
- Replacing the existing `Toaster` (it's a separate system, used for in-page success/error feedback, not for notifications).

## Verification

1. **Compiles + serves**: `cd routeflow-frontend && npm run dev`. Bell renders on `/seller/dashboard`, `/driver/dashboard`, `/admin/dashboard`.
2. **Initial count**: hit any dashboard with a seller/driver/admin account. The REST fetch returns rows; the badge shows the unread count.
3. **Real-time delivery**: with the seller dashboard open, fire a `notification:new` from a second session (e.g. assign a new order to that seller's account via a separate `curl` to the backend). The bell's count bumps within ~1s and the new item appears at the top of the dropdown when opened.
4. **Mark read**: click an unread item → the blue dot goes away, the count decrements, and a `PATCH /notifications/:id/read` is fired (check Network tab).
5. **Mark all read**: click "Mark all read" → count goes to 0, all dots gone, a `PATCH /notifications/read-all` is fired.
6. **Logout clears**: log out, log in as a different user, confirm the previous user's notifications don't show.
7. **No-socket fallback**: kill the backend, refresh — the bell still shows the cached list (loaded from the last successful fetch — but since we don't cache, the empty state appears with a "Live updates unavailable" tooltip). Restart the backend → bell re-subscribes on the next login.
