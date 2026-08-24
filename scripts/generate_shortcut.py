#!/usr/bin/env python3
"""Generate public/reseller-sale.shortcut as a binary plist.

Structures validated against:
  https://github.com/drewocarr/generate-shortcuts-skill
  (CONTROL_FLOW.md, ACTIONS.md, PARAMETER_TYPES.md, EXAMPLES.md)
"""
import plistlib, uuid as _uuid, subprocess, tempfile
from pathlib import Path

def uid():
    return str(_uuid.uuid4()).upper()

# ── serialization helpers ─────────────────────────────────────────────────────

def plain(s):
    """Static text — WFTextTokenString with no attachments."""
    return {"Value": {"attachmentsByRange": {}, "string": s},
            "WFSerializationType": "WFTextTokenString"}

def token_attach(output_uuid, output_name):
    """Single action-output ref — WFTextTokenAttachment.
    Use for WFInput, WFVariable, and similar single-value slots."""
    return {"Value": {"OutputUUID": output_uuid,
                      "OutputName": output_name,
                      "Type": "ActionOutput"},
            "WFSerializationType": "WFTextTokenAttachment"}

def token_string(output_uuid, output_name):
    """Action-output ref embedded in WFTextTokenString.
    Use for text fields (HTTP body values, notification body, etc.)."""
    return {"Value": {"attachmentsByRange": {"{0, 1}": {
                          "Aggrandizements": [],
                          "OutputUUID": output_uuid,
                          "OutputName": output_name,
                          "Type": "ActionOutput"}},
                      "string": "\ufffc"},
            "WFSerializationType": "WFTextTokenString"}

def token_string_prefix(prefix, output_uuid, output_name):
    """Literal text prefix followed by an action-output reference."""
    pos = len(prefix)
    return {"Value": {"attachmentsByRange": {f"{{{pos}, 1}}": {
                          "Aggrandizements": [],
                          "OutputUUID": output_uuid,
                          "OutputName": output_name,
                          "Type": "ActionOutput"}},
                      "string": prefix + "\ufffc"},
            "WFSerializationType": "WFTextTokenString"}

def vref_attach(name):
    """Named-variable ref — WFTextTokenAttachment (for get_var)."""
    return {"Value": {"Type": "Variable", "VariableName": name},
            "WFSerializationType": "WFTextTokenAttachment"}

# ── action builders ───────────────────────────────────────────────────────────

def text_act(s, u=None):
    p = {"WFTextActionText": plain(s)}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
            "WFWorkflowActionParameters": p}

def set_var(name):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": name}}

def get_var(name):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvariable",
            "WFWorkflowActionParameters": {"WFVariable": vref_attach(name)}}

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
        {"WFItemType": 0, "WFValue": plain(i)} for i in items]}
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

def get_dict_val(key_token_string, u=None):
    """Look up key in dictionary from previous action's implicit output.
    key_token_string: a WFTextTokenString referencing the chosen label."""
    p = {"WFDictionaryKey": key_token_string}
    if u: p["UUID"] = u
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": p}

def cond_if(gid, input_uuid, input_name, cond_str):
    """Conditional start.
    WFCondition must be the string "Equals" (not integer 4).
    WFInput uses WFTextTokenAttachment (per CONTROL_FLOW.md)."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid,
                "WFControlFlowMode": 0,
                "WFCondition": "Equals",
                "WFConditionalActionString": cond_str,
                "WFInput": token_attach(input_uuid, input_name)}}

def cond_else(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 1}}

def cond_end(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 2}}

def http_post(url, body_kv, u=None):
    """POST with JSON body.
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

def notify(prefix, output_uuid, output_name, title=None):
    p = {"WFNotificationActionBody": token_string_prefix(prefix, output_uuid, output_name),
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

# UUIDs for every action whose output is referenced downstream
#   action                               output name
TOKEN_UUID     = uid()   # text_act token          → "Text"
PAY_MAP_UUID   = uid()   # dict_act payment map    → "Dictionary"
MODE_UUID      = uid()   # choose_list mode        → "Chosen Item"
# Sale branch
ITEM_S_UUID    = uid()   # ask_text item name      → "Provided Input"
QTY_S_UUID     = uid()   # ask_num quantity        → "Provided Input"
PRICE_UUID     = uid()   # ask_num sale price      → "Provided Input"
PAY_LABEL_UUID = uid()   # choose_list pay label   → "Chosen Item"
PAY_VALUE_UUID = uid()   # get_dict_val pay code   → "Dictionary Value"
# Breakdown branch
ITEM_B_UUID    = uid()   # ask_text item name      → "Provided Input"
QTY_B_UUID     = uid()   # ask_num quantity        → "Provided Input"

actions = [
    # ── 0: Token (Import Question pre-fills on first install) ─────────────────
    text_act("PASTE_YOUR_TOKEN_HERE", u=TOKEN_UUID),

    # ── 1-2: Payment label→value map ──────────────────────────────────────────
    dict_act(PAYMENT_METHODS, u=PAY_MAP_UUID),
    set_var("PaymentMap"),      # persist as named var; retrieved inside If branch

    # ── 3: Mode choice ────────────────────────────────────────────────────────
    choose_list(["Record a Sale", "Break Down Inventory"],
                "What would you like to do?", u=MODE_UUID),

    # ── 4: If mode == "Record a Sale" ─────────────────────────────────────────
    #   WFCondition = "Equals" (string), WFInput = WFTextTokenAttachment
    cond_if(gid, MODE_UUID, "Chosen Item", "Record a Sale"),

        ask_text("What did you sell?", u=ITEM_S_UUID),
        ask_num("Quantity?", default=1, u=QTY_S_UUID),
        ask_num("Sale price?", u=PRICE_UUID),
        choose_list([p[0] for p in PAYMENT_METHODS], "Payment method?", u=PAY_LABEL_UUID),

        # Map label → code: get the PaymentMap dict, look up chosen label
        get_var("PaymentMap"),
        get_dict_val(token_string(PAY_LABEL_UUID, "Chosen Item"), u=PAY_VALUE_UUID),

        # POST — JSON body uses WFJSONValues (not WFFormValues)
        http_post(SALE_URL, [
            ("shortcut_token", token_string(TOKEN_UUID,     "Text")),
            ("item_name",      token_string(ITEM_S_UUID,    "Provided Input")),
            ("quantity",       token_string(QTY_S_UUID,     "Provided Input")),
            ("sale_price",     token_string(PRICE_UUID,     "Provided Input")),
            ("payment_method", token_string(PAY_VALUE_UUID, "Dictionary Value")),
        ]),
        notify("Sale recorded: ", ITEM_S_UUID, "Provided Input", "Log Sale"),

    # ── 5: Otherwise → Breakdown ──────────────────────────────────────────────
    cond_else(gid),

        ask_text("What are you breaking down?", u=ITEM_B_UUID),
        ask_num("Quantity?", default=1, u=QTY_B_UUID),

        http_post(BREAK_URL, [
            ("shortcut_token", token_string(TOKEN_UUID,  "Text")),
            ("item_name",      token_string(ITEM_B_UUID, "Provided Input")),
            ("quantity",       token_string(QTY_B_UUID,  "Provided Input")),
        ]),
        notify("Breakdown recorded: ", ITEM_B_UUID, "Provided Input", "Log Sale"),

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
