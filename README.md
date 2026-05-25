# StockScan

Mobile-first warehouse inventory control. Single-file vanilla web app (`index.html`) +
PWA shell. Camera barcode **and** serial scanning, check-in/out, per-unit serial tracking,
live shared stock via Supabase, offline-first with an auto-syncing write queue.

No framework, no build step — deploy the files as-is to any static host.

---

## 1. Files

| File | Purpose |
|---|---|
| `index.html` | The whole app (UI + logic). Config constants live at the top of the `<script type="module">`. |
| `manifest.webmanifest` | PWA manifest (installable, standalone). |
| `service-worker.js` | Offline app-shell cache (cache-first for CDN/fonts; never caches Supabase). |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons (dark tile + orange barcode mark). |

---

## 2. Configure (paste your keys)

Open **`index.html`**, find the `CONFIG` block near the top of the script, and edit:

```js
const SUPABASE_URL      = "https://YOUR-PROJECT.supabase.co"; // ← Supabase → Settings → API → Project URL
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";                    // ← Supabase → Settings → API → anon / publishable key
const APP_PASSCODE      = "1234";   // shared device passcode (change this!)
const DEFAULT_LANG      = "th";     // "th" or "en"
const CURRENCY          = "฿";
const SCAN_COOLDOWN_MS  = 1500;     // min time before the SAME code counts again
const FRAME_CLEAR_MS    = 800;      // empty frame this long => item left frame, may recount
```

> Only the **anon** key goes in the front-end — never the `service_role` key.
> Leaving the `YOUR-…` placeholders runs the app fully **local** (localStorage only, no sync).

---

## 3. Supabase setup checklist

1. Create a project at <https://supabase.com> (or use an existing one).
2. Open **SQL Editor** → **New query**, paste the **full SQL block below**, and **Run**.
3. Go to **Settings → API**. Copy the **Project URL** and the **anon / publishable** key.
4. Paste both into the `CONFIG` block in `index.html` (step 2 above).
5. **Settings → API → Realtime** is on by default; the SQL also adds both tables to the
   `supabase_realtime` publication so live sync works across devices.
6. Deploy (section 5) and open on two phones — a scan on one updates the other live.

### SQL — tables, RLS, policies, realtime

```sql
-- ============================================================
-- StockScan schema
-- SECURITY MODEL: open-with-passcode. The app gates entry with a
-- shared APP_PASSCODE in the front-end, and the anon role can
-- read+write both tables. This is fine for a trusted small team on
-- a private URL. To TIGHTEN later: add Supabase Auth (email/OTP),
-- swap the "anon" policies below for "authenticated", and add an
-- owner/org column with row-level checks (see note at the bottom).
-- ============================================================

-- catalog --------------------------------------------------------
create table if not exists public.products (
  code       text primary key,
  name       text,
  cost       numeric default 0,
  min        int     default 0,
  loc        text,
  tracking   text not null default 'quantity' check (tracking in ('quantity','serial')),
  qty        int     default 0,                 -- used only when tracking = 'quantity'
  updated_at timestamptz default now()
);

-- one row per serialized physical item ---------------------------
create table if not exists public.units (
  id              uuid primary key default gen_random_uuid(),
  code            text references public.products(code) on delete cascade,
  serial          text,
  status          text not null default 'in' check (status in ('in','out')),
  checked_in_at   timestamptz,
  checked_out_at  timestamptz,
  loc             text,                      -- shelf/bin, stamped on check-in (session shelf)
  updated_at      timestamptz default now(),
  unique (code, serial)
);

create index if not exists units_code_status_idx on public.units (code, status);

-- Row Level Security --------------------------------------------
alter table public.products enable row level security;
alter table public.units    enable row level security;

-- OPEN-WITH-PASSCODE policies: anon may read + write both tables.
-- (Front-end APP_PASSCODE is the only gate. Tighten later — see note.)
drop policy if exists products_anon_all on public.products;
create policy products_anon_all on public.products
  for all to anon using (true) with check (true);

drop policy if exists units_anon_all on public.units;
create policy units_anon_all on public.units
  for all to anon using (true) with check (true);

-- Realtime: broadcast row changes on both tables -----------------
alter publication supabase_realtime add table public.products;
alter publication supabase_realtime add table public.units;

-- Conflict rule: last-write-wins BY updated_at. Discards any update whose
-- updated_at is older than the row's current value, so a stale write (out-of-
-- order client writes, or a slow second device) can't clobber a fresher one.
create or replace function public.ss_lww_guard()
returns trigger language plpgsql as $$
begin
  if new.updated_at is null then new.updated_at := now(); end if;
  if old.updated_at is not null and new.updated_at < old.updated_at then
    return null;   -- ignore stale update, keep the newer row
  end if;
  return new;
end;
$$;
drop trigger if exists products_lww on public.products;
create trigger products_lww before update on public.products
  for each row execute function public.ss_lww_guard();
drop trigger if exists units_lww on public.units;
create trigger units_lww before update on public.units
  for each row execute function public.ss_lww_guard();

-- ── HOW TO TIGHTEN LATER (real per-user auth) ──────────────────
-- 1) Turn on Supabase Auth (email magic-link or OTP).
-- 2) Add an "org_id uuid" (or "owner") column to both tables.
-- 3) Replace the policies above with, e.g.:
--      create policy products_rw on public.products
--        for all to authenticated
--        using  (org_id = auth.jwt() ->> 'org_id')
--        with check (org_id = auth.jwt() ->> 'org_id');
--    and the equivalent for units.
-- 4) Sign users in (replace the front-end passcode gate with supabase.auth).
```

> Re-running this SQL is safe — it uses `if not exists` / `drop policy if exists`.
> If `alter publication … add table` errors with *"already member"*, that table is
> already realtime-enabled; ignore it.

---

## 4. Data model & behaviour

- **Effective on-hand** is used everywhere (list, stats, low-stock, value = on-hand × cost):
  - `tracking = 'quantity'` → `products.qty`
  - `tracking = 'serial'` → count of `units` for that code with `status = 'in'`
- **Optimistic writes**: local state updates instantly, then writes to Supabase and stamps
  `updated_at`. If a write fails (offline), it is queued in `localStorage` and **flushed
  automatically on reconnect**. Conflicts resolve **last-write-wins by `updated_at`**.
- **Realtime** on both tables keeps every device in sync.
- **Offline**: the app caches products + units to `localStorage` and opens showing last-known
  stock even with no network.
- **Session shelf**: the Scan view has a "Shelf · this session" field next to Check-in/out.
  Whatever it's set to is stamped on **every check-in** — onto `units.loc` for serialized
  items (each unit remembers its shelf, shown in the product sheet) and onto `products.loc`
  for quantity items. Leave it blank to skip. Autocompletes from previously-used locations.
- **Grouping (name + barcode → serials underneath)**: a product (barcode = `code`, plus
  `name`) is the parent; each S/N (`units`) is a sub-item linked by barcode. Scanning a
  barcode + S/N on one sticker files that serial under the product automatically; multiple
  stickers sharing a barcode collapse into one product with its serials listed beneath it.
  The product **name** comes from your **product master**: import a `code,name,…,tracking`
  CSV once (Import products), and every scan of that barcode resolves the name and groups
  serials with no typing. Mark serialized SKUs with `tracking = serial` in that CSV so their
  S/Ns become sub-items (otherwise the barcode is counted as a plain quantity).
- **Unknown barcode at check-in → auto-create + confirm**: if you scan a barcode that isn't
  in the catalog while checking in, the app creates the product on the spot (serialized if a
  serial was on the sticker), counts the scan, and pops a quick name box (pre-filled with the
  barcode) to confirm or rename — so scanning never stalls. Check-*out* of an unknown barcode
  just warns (you can't remove stock that was never recorded).

### CSV

- **Products** export/import columns: `code,name,cost,min,loc,tracking,qty`.
- **Units** export/import columns: `code,serial,status,loc` (`loc` optional on import).

---

## 5. Deploy (static host)

Any of these — just upload the files (keep them in the same folder so relative paths work):

**Cloudflare Pages / Netlify (drag-and-drop):** drop the project folder; serve `index.html`.

**Vercel:**
```bash
npm i -g vercel
vercel        # framework preset: "Other"; output dir = project root
```

**Netlify CLI:**
```bash
npm i -g netlify-cli
netlify deploy --dir . --prod
```

> Must be served over **HTTPS** (or `http://localhost`) — the camera (`getUserMedia`) and the
> service worker both require a secure context. iPhone/Safari uses the bundled
> `barcode-detector` polyfill (loaded from esm.sh) since it has no native `BarcodeDetector`.

### Local test
```bash
npx serve .        # or: python -m http.server 8080
# open http://localhost:3000 (or :8080) — localhost counts as a secure context
```

---

## 6. Acceptance checks

1. **Realtime** — open two tabs/phones; a scan or qty change on one appears on the other.
2. **Offline** — go offline, make changes, reopen the app → last-known stock shows; go back
   online → queued writes flush (watch the `⟳N` badge in the header clear).
3. **Anti-double-scan** — hold one barcode steady in continuous mode → counted once.
4. **Serial safety** — checking the same serial in twice → "Already in stock", no change.
5. **Dual code** — a sticker with a product barcode + a serial barcode is read in one frame.
6. **Product-only** — a SKU with no serial scans fine as product-only.

---

## 7. Notes / extension hooks

- **OCR (optional):** `promptSerial()` in `index.html` has a marked hook where Tesseract.js
  could read a *printed* serial to pre-fill the field.
- **Role assignment:** `assignRoles()` is a small, commented function — tweak the
  product-vs-serial precedence there.
