"""OS input for isolated visual fixtures, never WebContents.sendInputEvent."""
import ctypes
import json
import os
import sys
import time

point = json.loads(sys.argv[1])
x, y = int(point["x"]), int(point["y"])
click = point.get("click", False)
drag = point.get("drag")
wheel = int(point.get("wheel", 0))  # Discrete vertical wheel notches; positive is down.

if sys.platform == "linux":
    x11 = ctypes.CDLL("libX11.so.6")
    xtst = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Native pointer requires the fixture's DISPLAY")
    try:
        xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
        x11.XSync(display, 0)
        # The desk polls the real cursor every 16 ms before enabling native hits.
        time.sleep(0.08)
        if click or drag:
            try:
                xtst.XTestFakeButtonEvent(display, 1, 1, 0)
                x11.XSync(display, 0)
                if drag:
                    time.sleep(0.04)
                    for step in range(1, 9):
                        dx = round(x + (int(drag["x"]) - x) * step / 8)
                        dy = round(y + (int(drag["y"]) - y) * step / 8)
                        xtst.XTestFakeMotionEvent(display, -1, dx, dy, 0)
                        x11.XSync(display, 0)
                        time.sleep(0.04)
            finally:
                xtst.XTestFakeButtonEvent(display, 1, 0, 0)
                x11.XSync(display, 0)
        for _ in range(abs(wheel)):
            button = 5 if wheel > 0 else 4
            try:
                xtst.XTestFakeButtonEvent(display, button, 1, 0)
            finally:
                xtst.XTestFakeButtonEvent(display, button, 0, 0)
                x11.XSync(display, 0)
            time.sleep(0.03)
    finally:
        x11.XCloseDisplay(display)
elif sys.platform == "darwin":
    if os.environ.get("SKIFF_VISUAL_DESKTOP") != "1":
        raise RuntimeError("Native Mac input requires an explicitly available test desktop")
    services = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
    services.CGPreflightPostEventAccess.restype = ctypes.c_bool
    if not services.CGPreflightPostEventAccess():
        raise RuntimeError("Native Mac input requires event-posting approval for the test runner")

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    services.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
    services.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    # CGEvent.h's fixed six-argument API, not the variadic predecessor.
    services.CGEventCreateScrollWheelEvent2.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
        ctypes.c_int32, ctypes.c_int32, ctypes.c_int32,
    ]
    services.CGEventCreateScrollWheelEvent2.restype = ctypes.c_void_p
    services.CGEventSetLocation.argtypes = [ctypes.c_void_p, CGPoint]
    services.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    services.CFRelease.argtypes = [ctypes.c_void_p]

    def send(kind, px=x, py=y):
        event = services.CGEventCreateMouseEvent(None, kind, CGPoint(px, py), 0)
        if not event:
            raise RuntimeError("Could not create native mouse event")
        try:
            services.CGEventPost(0, event)
        finally:
            services.CFRelease(event)

    send(5)  # kCGEventMouseMoved
    time.sleep(0.08)
    if click or drag:
        at_x, at_y = x, y
        try:
            send(1)  # kCGEventLeftMouseDown
            if drag:
                time.sleep(0.04)
                for step in range(1, 9):
                    at_x = round(x + (int(drag["x"]) - x) * step / 8)
                    at_y = round(y + (int(drag["y"]) - y) * step / 8)
                    send(6, at_x, at_y)  # kCGEventLeftMouseDragged (IOLLEvent.h)
                    time.sleep(0.04)
        finally:
            send(2, at_x, at_y)  # Always release the left button.
    for _ in range(abs(wheel)):
        # kCGScrollEventUnitLine = 1 (CGEventTypes.h). Discrete mouse-wheel
        # events have no trackpad gesture/momentum phases.
        event = services.CGEventCreateScrollWheelEvent2(None, 1, 1, -1 if wheel > 0 else 1, 0, 0)
        if not event:
            raise RuntimeError("Could not create native wheel event")
        try:
            services.CGEventSetLocation(event, CGPoint(x, y))
            services.CGEventPost(0, event)
        finally:
            services.CFRelease(event)
        time.sleep(0.03)
else:
    raise RuntimeError("Native pointer supports Linux and macOS only")
