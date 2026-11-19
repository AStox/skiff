# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron, plain HTML/CSS/JS shell, no framework and no build step. Chosen with the user over a Chromium fork to avoid maintaining one.

## Users

One user, Adam, using it as a daily browser on macOS, plus the AI agents he asks to change it.

## Product Purpose

A bare-bones browser that keeps the parts of Arc he liked: spaces, vertical tabs, favorites and tabs that archive themselves. Sync across devices is wanted later and is out of the first version.

## Positioning

The whole interface is a folder of files driven by one command API. The user or an agent can rewrite any part of it, and anything the interface can do is also a command an agent can call.

## Capabilities and Constraints

- Spaces, vertical tabs, favorites that belong to one space and show as icon tiles, auto-archive that never touches favorites and can always be undone.
- A command bar (Cmd+T for a new tab, Cmd+L to edit the current address) that completes the top result inline and lists open tabs, known sites and archived tabs. Tab on a site turns the bar into a search of that site, from a built-in table of sites that is plain data in the shell.
- Trails: a tab opened from another tab sits indented under it.
- Pinning and favoriting by drag, with a preview of the exact result before you let go. No pin or star buttons.
- One incognito space (Cmd+Shift+N). Its tabs, cookies and site data live in memory and are gone when it closes. Nothing in it is saved or archived.
- Site icons are saved as local files. Opening a page saves its icon. Imported tabs use the icons Arc saved. Startup and import ask a site once for an icon no one has yet, without credentials.
- Web pages never get the command API.
- uBlock Origin is built in: installed from its GitHub release at first launch, updated in place while Skiff runs, its dashboard one click away in Settings. Other unpacked Chrome extensions load from the profile, but Electron lacks part of Chrome's API, so they may not work; uBlock Origin Lite cannot.
- Typing in the command bar offers to ask Adam's own AI agent (omp, Gemini, Codex, Claude or any other) over the Agent Client Protocol, with a choice of agent, model and effort; Cmd+J opens it that way. Agents, the default one and its default model and effort are set in Settings, in the default and Layer shells. Each question opens a chat tab under the page it came from, a quiet reading view after bb with the model and effort in its composer, restored after a restart when the agent can load its sessions. A page is sent only when asked, the agent gets a few browser tools, incognito pages are never sent, and Skiff stores no keys.
- In the Layer desk shell a two finger swipe up on the Buoy or a window's ear spreads the space's windows out across the screen, as Mission Control does; a click brings one forward, a swipe down or Escape puts them back.
- Arc import with isolated profile sessions and optional local password and sign-in migration. Sensitive imports require native consent; passwords fill only after choosing an account for the exact site. Icons come from Arc's own saved icons first. A site Arc had no icon for is asked once, without sign-ins. Imported space backgrounds keep Arc's colors, left to right with overlays top to bottom.
- Not built: sync, a general profile editor, split view, find in page, history, downloads list.
- "Skiff" is a working name.

## Product Principles

1. Fewer features, each one replaceable.
2. The interface and agents use the same commands.
3. Nothing the browser does on its own (archiving, closing) loses a tab for good. Incognito is the chosen exception.
4. The page is the point; the shell stays quiet.
