# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron, plain HTML/CSS/JS shell, no framework and no build step. Chosen with the user over a Chromium fork to avoid maintaining one.

## Users

One user, Adam, using it as a daily browser on macOS, plus the AI agents he asks to change it.

## Product Purpose

A local-first browser that keeps the parts of Arc Adam liked: spaces, vertical tabs, favorites and reversible auto-archive. It adds independently replaceable local components and manual, opt-in encrypted sync without a hosted account.

## Positioning

A small browser host owns sessions, native page views and persistence. Stock and user-owned components provide independently replaceable UI and behavior through one typed command registry. Owner automation uses the local API; agents receive explicit, revocable scopes rather than owner credentials.

## Capabilities and Constraints

- Spaces, vertical tabs, favorites that belong to one space and show as icon tiles, auto-archive that never touches favorites and can always be undone.
- A command bar (Cmd+T for a new tab, Cmd+L to edit the current address) that completes the top result inline and lists open tabs, known sites and archived tabs. Tab on a site turns the bar into a search of that site, from a built-in table of sites that is plain data in the shell.
- Trails can be nested and collapsed. Persisted folders can be nested or empty.
- Pinning and favoriting by drag, with a preview of the exact result before you let go. No pin or star buttons.
- Any tab or window can move to another space: drag it onto a space dot, or right-click the page and pick Move to Space (`tabs.move`). It takes that space's profile, so a Dev tab moved to Work reloads signed in as Work; a link peek moved to a space becomes a real tab there. Spaces on one profile keep the live page.
- One incognito space (Cmd+Shift+N). Its tabs, cookies and site data live in memory and are gone when it closes. Nothing in it is saved or archived.
- Site icons are saved as local files. Opening a page saves its icon. Imported tabs use the icons Arc saved. Startup and import ask a site once for an icon no one has yet, without credentials.
- Web pages never get the command API.
- uBlock Origin is built in: installed from its GitHub release at first launch, updated in place while Skiff runs, its dashboard one click away in Settings. Other unpacked Chrome extensions load from the profile, but Electron lacks part of Chrome's API, so they may not work; uBlock Origin Lite cannot.
- ACP agents remain user-selected processes with their own credentials. Page inclusion is deliberate, never automatic capture. Browser access requires explicit tab/space and read/mutation grants; optional component tools require separate selection. Opt-in local transcripts support configurable retention, search, export, deletion and read-only recovery. Failed ACP restoration requires a fresh session, without hidden replay of local transcripts. Private chats are not persisted by Skiff.
- In the Layer desk shell the Buoy is the command bar: Cmd+T, Cmd+S or a click on it grows the pill into a card in the middle of the desk, with the bar's input on top and, while it is empty, the space's favorites, pinned tabs, tabs and settings below; a pick or Escape shrinks it back into the pill.
- In the Layer desk shell a two finger swipe up on the Buoy or a window's ear spreads the space's windows out across the screen, as Mission Control does; a click brings one forward, a swipe down or Escape puts them back.
- On a Mac with several desktops every desktop has its own Layer desk window, so switching desktops slides each desktop's own pages in and out and never shows the ones just left. Skiff never switches desktops: each tab belongs to the desktop it was opened on, the desk shows only the current desktop's tabs, and the tab list and exposé show every desktop's tabs under its "Desktop N" label; picking a tab from another desktop moves it to this one. A desktop Skiff has not seen yet shows an empty desk for a moment before its window arrives.
- Arc import with isolated profile sessions and optional local password and sign-in migration. Sensitive imports require native consent; passwords fill only after choosing an account for the exact site. Icons come from Arc's own saved icons first. A site Arc had no icon for is asked once, without sign-ins. Imported space backgrounds keep Arc's colors, left to right with overlays top to bottom.
- Searchable settings and commands, find in page, reversible reader mode, split view, user link peek, history, downloads, per-profile site permissions and persisted zoom, profile management and external-link routing.
- Opt-in memory saver protects active or unsafe pages. Waking a discarded page reloads it; arbitrary JavaScript and scroll state are not preserved. Crashed pages can be reloaded.
- Components have discoverable source, owned copies, check/preview/apply/revert, global or per-space role bindings, manifest-declared scalar settings with owner and value provenance, versioned storage and safe-mode recovery. Local backends are trusted Node programs, not an OS sandbox. Webpage preloads expose no privileged API.
- Manual end-to-end encrypted sync uses a user-provided WebDAV endpoint or shared folder. Pairing and unlock are explicit. Cookies, passwords, private state, transcripts and component source do not sync.
- Initial isolated Linux native smoke covered find, reader, split, peek and history with page and cookie continuity. Wider native review and macOS acceptance are not claimed complete.
- "Skiff" is a working name.

## Product Principles

1. Fewer features, each one replaceable.
2. The interface and agents use the same commands.
3. Nothing the browser does on its own (archiving, closing) loses a tab for good. Incognito is the chosen exception.
4. The page is the point; the shell stays quiet.
