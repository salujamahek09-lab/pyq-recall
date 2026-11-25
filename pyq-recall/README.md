# PYQ Recall

A spaced-repetition planner for the DNB Anaesthesia PYQ book (Volumes 1–5, 456 topics), as an app for iPhone, iPad and laptop. It installs from your home screen, opens without internet, and syncs through your own free Supabase project.

---

## Setup (about 15 minutes, once, on your laptop)

### 1. Supabase: your private database
1. Go to **supabase.com** → **Start your project** → sign up (signing in with GitHub is quickest).
2. **New project** → name it `pyq-recall`, make up a database password (save it somewhere), choose region **South Asia (Mumbai)** → **Create**. Wait about 2 minutes.
3. Left menu → **SQL Editor** → **New query**. Open `supabase-setup.sql` from this folder, copy **all** of it, paste, then press **Run**.
   - At the bottom you will see a **reminder_key** (a long code). Copy it into Notes; Claude needs it for the nightly reminder.
4. Left menu → **Authentication** → **Sign In / Providers** (or **Providers**) → **Email** → turn **off** “Confirm email” → **Save**. This lets you create your account straight from the app.
5. Click **Connect** at the top (or **Project Settings → API**) and copy two things:
   - **Project URL**, like `https://abcdefghijklmnop.supabase.co`
   - **anon public** key (a long code starting `eyJ…` or `sb_publishable_…`)

### 2. GitHub Pages: the app's web address
1. Go to **github.com** → **Sign up** (free).
2. Top right **+** → **New repository** → name `pyq-recall` → **Public** → **Create repository**.
3. Click **uploading an existing file**. Unzip the app folder, select **everything inside it** (including the `icons` folder) and drag it in → **Commit changes**.
4. In the repository, click **config.js** → the **pencil** icon → paste your Project URL and anon key between the quotes → **Commit changes**.
5. **Settings** → **Pages** → Source: **Deploy from a branch** → Branch **main**, folder **/(root)** → **Save**.
6. After a minute the page shows your link: `https://YOUR-USERNAME.github.io/pyq-recall/`

### 3. Install it
- **iPhone / iPad:** open the link in **Safari** → **Share** → **Add to Home Screen** → **Add**. Open it from the home screen.
- **Mac laptop:** in Safari, **File → Add to Dock**. In Chrome or Edge, click the install icon in the address bar.
- First time: tap **New here? Create an account** with your email and a password. The first account becomes the planner owner. On your other devices, just **Sign in**.

### 4. Your study buddy
1. Send her the link. She installs it the same way and taps **Create an account** with her name.
2. Once she has joined, go back to Supabase → **Authentication** → **Sign In / Providers** → turn **off** “Allow new users to sign up” → **Save**. Now nobody else can join.

### 5. Nightly 8:45 pm reminder from Claude
1. In claude.ai (web browser) → **Settings** → **Capabilities** → allowed domains → add your Supabase address, e.g. `abcdefghijklmnop.supabase.co`.
2. Tell Claude your **Project URL** and **reminder_key**. Claude points the reminder at your app. The key is read-only: it can list what is due but cannot change anything.

---

## Good to know
- **Offline:** ratings made without internet are kept on the device and upload automatically when you are back online. The top-right dot shows “Offline · 2 to sync” until then.
- **Backup:** Settings → **Copy** puts your whole plan on the clipboard as text (paste it into Notes). **Restore** brings it back.
- **Privacy:** the app's code in this repository is public; your progress is not. It lives in your Supabase project, and only signed-in members can read it.
- **Updating the app later:** replace the changed files in the repository. Phones pick up the new version the next time the app is opened with internet.
- The app loads the official Supabase client library (v2.109.0, MIT licence, see `supabase.LICENSE.txt`) from jsDelivr once, then keeps a copy for offline use.
