#!/usr/bin/env python3
"""Generate public/reseller-sale.shortcut as a binary plist.

Structures validated against:
  https://github.com/drewocarr/generate-shortcuts-skill
  (CONTROL_FLOW.md, ACTIONS.md, PARAMETER_TYPES.md, VARIABLES.md)

Data-passing strategy:
  - Named variables (set_var/get_var) for all inter-action values.
    Using Type="Variable"/VariableName is reliable regardless of what
    Shortcuts internally names action outputs.
  - ActionOutput UUIDs are still assigned but not used in WFInput refs.
"""
import plistlib, uuid as _uuid, subprocess, tempfile
from pathlib import Path

def uid():
    return str(_uuid.uuid4()).upper()

# ── serialization helpers ─────────────────────────────────────────────────────

def plain(s):
    """Static text — WFTextTokenString, no attachments."""
    return {"Value": {"attachmentsByRange": {}, "string": s},
            "WFSerializationType": "WFTextTokenString"}

def var_attach(name):
    """Named-variable ref — WFTextTokenAttachment.
    Use for WFInput, WFVariable, and other single-value parameters."""
    return {"Value": {"Type": "Variable", "VariableName": name,
                      "Aggrandizements": []},
            "WFSerializationType": "WFTextTokenAttachment"}

def var_str(name):
    """Named-variable ref embedded in WFTextTokenString.
    Use for text fields (HTTP body values, notification body, etc.)."""
    return {"Value": {"attachmentsByRange": {"{0, 1}": {
                          "Aggrandizements": [], "Type": "Variable",
                          "VariableName": name}},
                      "string": "\ufffc"},
            "WFSerializationType": "WFTextTokenString"}

def var_str_prefix(prefix, name):
    """Literal prefix + named-variable ref in WFTextTokenString."""
    pos = len(prefix)
    return {"Value": {"attachmentsByRange": {f"{{{pos}, 1}}": {
                          "Aggrandizements": [], "Type": "Variable",
                          "VariableName": name}},
                      "string": prefix + "\ufffc"},
            "WFSerializationType": "WFTextTokenString"}

# ── action builders ───────────────────────────────────────────────────────────

def text_act(s, u=None):
    p = {"WFTextActionText": plain(s)}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
            "WFWorkflowActionParameters": p}

def set_var(name):
    """Store previous action's output as a named variable."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": name}}

def get_var(name, u=None):
    p = {"WFVariable": var_attach(name)}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvariable",
            "WFWorkflowActionParameters": p}

def ask_text(prompt, u=None):
    p = {"WFAskActionPrompt": prompt, "WFInputType": "Text"}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
            "WFWorkflowActionParameters": p}

def ask_num(prompt, default=None, u=None):
    p = {"WFAskActionPrompt": prompt, "WFInputType": "Number"}
    if default is not None: p["WFAskActionDefaultAnswer"] = str(default)
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
            "WFWorkflowActionParameters": p}

def choose_list(items, prompt=None, u=None):
    p = {"WFChooseFromListActionList": [
        {"WFItemType": 0, "WFValue": i} for i in items]}
    if prompt: p["WFChooseFromListActionPrompt"] = prompt
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.choosefromlist",
            "WFWorkflowActionParameters": p}

def dict_act(pairs, u=None):
    items = [{"WFItemType": 0, "WFKey": plain(k), "WFValue": plain(v)}
             for k, v in pairs]
    p = {"WFItems": {"Value": {"WFDictionaryFieldValueItems": items},
                     "WFSerializationType": "WFDictionaryFieldValue"}}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.dictionary",
            "WFWorkflowActionParameters": p}

def get_dict_val(dict_var, key_var, u=None):
    """Get value from a named-variable dictionary by a named-variable key.
    WFInput  = WFTextTokenAttachment referencing the dict named var.
    WFDictionaryKey = WFTextTokenString referencing the key named var."""
    p = {"WFInput": var_attach(dict_var),
         "WFDictionaryKey": var_str(key_var)}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": p}

def cond_if(gid, var_name, cond_str):
    """Conditional start.
    WFCondition = "Equals" (string, confirmed by official docs).
    WFInput = WFTextTokenAttachment referencing a named variable."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid,
                "WFControlFlowMode": 0,
                "WFCondition": "Equals",
                "WFConditionalActionString": cond_str,
                "WFInput": var_attach(var_name)}}

def cond_else(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 1}}

def cond_end(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 2}}

def http_post(url, body_kv, u=None):
    """POST JSON body.
    WFHTTPBodyType = "JSON" → body key is WFJSONValues (not WFFormValues).
    body_kv: list of (key_str, WFTextTokenString value)."""
    body_items = [{"WFItemType": 0, "WFKey": plain(k), "WFValue": v}
                  for k, v in body_kv]
    p = {
        "WFHTTPMethod": "POST",
        "WFURL": plain(url),
        "WFHTTPBodyType": "JSON",
        "ShowHeaders": False,
        "WFHTTPHeaders": {
            "Value": {"WFDictionaryFieldValueItems": [
                {"WFItemType": 0,
                 "WFKey": plain("Content-Type"),
                 "WFValue": plain("application/json")}]},
            "WFSerializationType": "WFDictionaryFieldValue"},
        "WFJSONValues": {
            "Value": {"WFDictionaryFieldValueItems": body_items},
            "WFSerializationType": "WFDictionaryFieldValue"},
    }
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": p}

def notify(prefix, var_name, title=None):
    p = {"WFNotificationActionBody": var_str_prefix(prefix, var_name),
         "WFNotificationActionSound": True}
    if title: p["WFNotificationActionTitle"] = plain(title)
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
            "WFWorkflowActionParameters": p}

# ── shortcut definition ───────────────────────────────────────────────────────

SALE_URL  = "https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale"
BREAK_URL = "https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_breakdown"

PAYMENT_METHODS = [
    ("Cash", "cash"), ("Venmo", "venmo"), ("Cash App", "cashapp"),
    ("PayPal", "paypal"), ("Apple Pay", "apple_pay"), ("Zelle", "zelle"),
    ("Card", "card"), ("Other", "other"),
]

gid = uid()

actions = [
    # ── Token (Import Question pre-fills on first install) ────────────────────
    text_act("PASTE_YOUR_TOKEN_HERE"),
    set_var("Token"),

    # ── Payment label → value map ─────────────────────────────────────────────
    dict_act(PAYMENT_METHODS),
    set_var("PaymentMap"),

    # ── Mode: Sale or Breakdown ───────────────────────────────────────────────
    choose_list(["Record a Sale", "Break Down Inventory"],
                "What would you like to do?"),
    set_var("Mode"),

    # ── If Mode == "Record a Sale" ────────────────────────────────────────────
    cond_if(gid, "Mode", "Record a Sale"),

        ask_text("What did you sell?"),
        set_var("ItemName"),

        ask_num("Quantity?", default=1),
        set_var("Qty"),

        ask_num("Sale price?"),
        set_var("SalePrice"),

        choose_list([p[0] for p in PAYMENT_METHODS], "Payment method?"),
        set_var("PayLabel"),

        # Map label → code using the PaymentMap dictionary
        get_dict_val("PaymentMap", "PayLabel"),
        set_var("PayValue"),

        http_post(SALE_URL, [
            ("shortcut_token", var_str("Token")),
            ("item_name",      var_str("ItemName")),
            ("quantity",       var_str("Qty")),
            ("sale_price",     var_str("SalePrice")),
            ("payment_method", var_str("PayValue")),
        ]),
        notify("Sale recorded: ", "ItemName", "Log Sale"),

    # ── Otherwise → Breakdown ─────────────────────────────────────────────────
    cond_else(gid),

        ask_text("What are you breaking down?"),
        set_var("ItemName"),

        ask_num("Quantity?", default=1),
        set_var("Qty"),

        http_post(BREAK_URL, [
            ("shortcut_token", var_str("Token")),
            ("item_name",      var_str("ItemName")),
            ("quantity",       var_str("Qty")),
        ]),
        notify("Breakdown recorded: ", "ItemName", "Log Sale"),

    cond_end(gid),
]

shortcut = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2605.1",
    "WFWorkflowHasOutputFallthrough": False,
    "WFWorkflowIcon": {
        "WFWorkflowIconGlyphNumber": 59511,
        "WFWorkflowIconStartColor": 463140863,
    },
    "WFWorkflowImportQuestions": [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "DefaultValue": "",
            "ParameterKey": "WFTextActionText",
            "Text": "Paste your Shortcut Token (Settings \u2192 Apple Shortcuts)",
        }
    ],
    "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowName": "Log Sale",
    "WFWorkflowTypes": [],
    "WFWorkflowHasShortcutInputVariables": False,
}

# ── write: unsigned temp → sign → output ─────────────────────────────────────

out = Path(__file__).parent.parent / "public" / "reseller-sale.shortcut"
out.parent.mkdir(exist_ok=True)

with tempfile.NamedTemporaryFile(suffix=".shortcut", delete=False) as tmp:
    plistlib.dump(shortcut, tmp, fmt=plistlib.FMT_BINARY)
    tmp_path = tmp.name

subprocess.run(
    ["shortcuts", "sign", "--mode", "anyone", "--input", tmp_path, "--output", str(out)],
    check=True,
)
Path(tmp_path).unlink(missing_ok=True)

print(f"✓  {out}")
print(f"   {out.stat().st_size:,} bytes  |  {len(actions)} actions  |  group {gid[:8]}…")
