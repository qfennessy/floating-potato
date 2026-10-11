"""Commanders decide whether to chase a science event. Same signature for both:

    commander(event, state, eta_h, hours_left, fixed_todo) -> ("chase" | "ignore", reason)

eta_h is the planner's best capture time for the event (None if it can't make it in time).
"""
import json
import os
import urllib.request

MODEL = "gemini-robotics-er-2-preview"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

TOOLS = [{"functionDeclarations": [
    {"name": "chase_event",
     "description": "Divert the balloon to investigate this event. Fixed targets wait until it is reached or fades.",
     "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}},
    {"name": "stay_course",
     "description": "Ignore this event and keep flying toward the fixed science targets.",
     "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}},
]}]


def rule_commander(ev, st, eta_h, hours_left, fixed_todo):
    """Chase anything the planner can reach in time if it's worth 2+ points or is close."""
    v = ev.spec["value"]
    if eta_h is None:
        return "ignore", f"Can't reach {ev.label()} in the {hours_left:.0f} h before it fades; staying on course."
    if v >= 2 or eta_h <= 12:
        return "chase", f"Diverting: {ev.label()} is worth {v:.0f} points and reachable in about {eta_h:.0f} h."
    return "ignore", f"{ev.label()} is only worth {v:.0f} point and {eta_h:.0f} h away; staying on course."


def _prompt(ev, st, eta_h, hours_left, fixed_todo):
    eta = "the planner cannot reach it before it fades" if eta_h is None else \
        f"the planner can reach it in about {eta_h:.0f} hours"
    return (
        "You command a research balloon in the cloud layer of Venus, 50-62 km up. Winds carry it "
        "west; it steers only by changing altitude, and a separate planner handles altitude.\n"
        f"Now: {st.hours:.0f} hours into a 10-day mission, at lat {st.lat:.1f}, lon {st.lon:.1f} E, "
        f"altitude {st.alt:.1f} km.\n"
        f"Your {ev.spec['sensor']} just reported: {ev.label()}, around lat {ev.rep_lat:.1f}, "
        f"lon {ev.rep_lon:.1f} E. It is worth {ev.spec['value']:.0f} science points and fades in "
        f"{hours_left:.0f} hours; {eta}.\n"
        f"Fixed targets still unvisited (1 point each, they come around every lap): "
        f"{', '.join(fixed_todo) or 'none'}.\n"
        "Decide by calling exactly one tool. Give a one-sentence reason a mission log reader understands."
    )


def gemini_commander(thinking="medium", timeout=30):
    """Gemini Robotics-ER as commander. Falls back to the rule commander if the call fails."""
    key = os.environ.get("GEMINI_API_KEY")

    def decide(ev, st, eta_h, hours_left, fixed_todo):
        if not key:
            c, r = rule_commander(ev, st, eta_h, hours_left, fixed_todo)
            return c, r + " (rule fallback: no GEMINI_API_KEY)"
        body = {
            "contents": [{"role": "user", "parts": [{"text": _prompt(ev, st, eta_h, hours_left, fixed_todo)}]}],
            "tools": TOOLS,
            "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
            "generationConfig": {"thinkingConfig": {"thinkingLevel": thinking}},
        }
        req = urllib.request.Request(URL, json.dumps(body).encode(), method="POST", headers={
            "Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                parts = json.load(resp)["candidates"][0]["content"]["parts"]
            call = next(p["functionCall"] for p in parts if "functionCall" in p)
            choice = "chase" if call["name"] == "chase_event" else "ignore"
            return choice, call.get("args", {}).get("reason", "").strip() or call["name"]
        except Exception as e:  # network, quota, or an answer without a tool call
            c, r = rule_commander(ev, st, eta_h, hours_left, fixed_todo)
            return c, r + f" (rule fallback: {type(e).__name__})"

    return decide
