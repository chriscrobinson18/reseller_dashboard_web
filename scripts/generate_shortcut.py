#!/usr/bin/env python3
"""Generate public/reseller-sale.shortcut as a binary plist."""
import plistlib
import uuid
from pathlib import Path

# ── helpers ──────────────────────────────────────────────────────────────────

def plain(s):
    return {"Value": {"attachmentsByRange": {}, "string": s},
            "WFSerializationType": "WFTextTokenString"}

def vref(name):
    return {"Value": {"attachmentsByRange": {"{0, 1}": {
                "Aggrandizements": [], "Type": "Variable", "VariableName": name}},
            "string": "\ufffc"},
            "WFSerializationType": "WFTextTokenString"}

def concat_parts(parts):
    """parts: list of ("t", "literal") or ("v", "VarName")"""
    s, att = "", {}
    for kind, val in parts:
        if kind == "t":
            s += val
        else:
            att[f"{{{len(s)}, 1}}"] = {
                "Aggrandizements": [], "Type": "Variable", "VariableName": val}
            s += "\ufffc"
    return {"Value": {"attachmentsByRange": att, "string": s},
            "WFSerializationType": "WFTextTokenString"}

def set_var(name):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {"WFVariableName": name}}

def get_var(name):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvariable",
            "WFWorkflowActionParameters": {"WFVariable": {
                "Value": {"Type": "Variable", "VariableName": name},
                "WFSerializationType": "WFTextTokenAttachment"}}}

def text_act(s):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
            "WFWorkflowActionParameters": {"WFTextActionText": plain(s)}}

def ask_text(prompt):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
            "WFWorkflowActionParameters": {
                "WFAskActionPrompt": prompt, "WFInputType": "Text"}}

def ask_num(prompt, default=None):
    p = {"WFAskActionPrompt": prompt, "WFInputType": "Number"}
    if default is not None:
        p["WFAskActionDefaultAnswer"] = str(default)
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
            "WFWorkflowActionParameters": p}

def choose_list(items, prompt=None):
    p = {"WFChooseFromListActionList": [
        {"WFItemType": 0, "WFValue": plain(i)} for i in items]}
    if prompt:
        p["WFChooseFromListActionPrompt"] = prompt
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.choosefromlist",
            "WFWorkflowActionParameters": p}

def dict_act(pairs):
    items = [{"WFItemType": 0, "WFKey": plain(k), "WFValue": plain(v)}
             for k, v in pairs]
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.dictionary",
            "WFWorkflowActionParameters": {"WFItems": {
                "Value": {"WFDictionaryFieldValueItems": items},
                "WFSerializationType": "WFDictionaryFieldValue"}}}

def get_dict_val(key_var):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
            "WFWorkflowActionParameters": {"WFDictionaryKey": vref(key_var)}}

def cond_if(gid, var_name, cond_str):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 0,
                "WFCondition": 4,                          # "is"
                "WFConditionalActionString": cond_str,
                "WFInput": {
                    "Value": {"Type": "Variable", "VariableName": var_name},
                    "WFSerializationType": "WFTextTokenAttachment"}}}

def cond_else(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 1}}

def cond_end(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid, "WFControlFlowMode": 2}}

def http_post(url, body_vars):
    body_items = [{"WFItemType": 0, "WFKey": plain(k), "WFValue": vref(v)}
                  for k, v in body_vars]
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
            "WFWorkflowActionParameters": {
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
                "WFFormValues": {
                    "Value": {"WFDictionaryFieldValueItems": body_items},
                    "WFSerializationType": "WFDictionaryFieldValue"}}}

def notify(parts, title=None):
    p = {"WFNotificationActionBody": concat_parts(parts),
         "WFNotificationActionSound": True}
    if title:
        p["WFNotificationActionTitle"] = plain(title)
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

gid = str(uuid.uuid4()).upper()   # shared group ID for the Sale/Breakdown if block

actions = [
    # ── Token (action index 0 — Import Question pre-fills this) ──────────────
    text_act("PASTE_YOUR_TOKEN_HERE"),
    set_var("Token"),

    # ── Payment label→value map ───────────────────────────────────────────────
    dict_act(PAYMENT_METHODS),
    set_var("PaymentMap"),

    # ── Mode choice ───────────────────────────────────────────────────────────
    choose_list(["Record a Sale", "Break Down Inventory"],
                "What would you like to do?"),
    set_var("Mode"),

    # ── If Sale ───────────────────────────────────────────────────────────────
    cond_if(gid, "Mode", "Record a Sale"),

      ask_text("What did you sell?"),
      set_var("ItemName"),

      ask_num("Quantity?", 1),
      set_var("Qty"),

      ask_num("Sale price?"),
      set_var("SalePrice"),

      choose_list([p[0] for p in PAYMENT_METHODS], "Payment method?"),
      set_var("PayLabel"),

      get_var("PaymentMap"),
      get_dict_val("PayLabel"),
      set_var("PayValue"),

      http_post(SALE_URL, [
          ("shortcut_token", "Token"),
          ("item_name",      "ItemName"),
          ("quantity",       "Qty"),
          ("sale_price",     "SalePrice"),
          ("payment_method", "PayValue"),
      ]),
      notify([("t", "Sale recorded: "), ("v", "ItemName")], "Log Sale"),

    # ── Otherwise Breakdown ───────────────────────────────────────────────────
    cond_else(gid),

      ask_text("What are you breaking down?"),
      set_var("ItemName"),

      ask_num("Quantity?", 1),
      set_var("Qty"),

      http_post(BREAK_URL, [
          ("shortcut_token", "Token"),
          ("item_name",      "ItemName"),
          ("quantity",       "Qty"),
      ]),
      notify([("t", "Breakdown recorded: "), ("v", "ItemName")], "Log Sale"),

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
    # Import Question: Shortcuts will ask for the token on first install
    # and pre-fill the Text action at index 0.
    "WFWorkflowImportQuestions": [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "DefaultValue": "",
            "ParameterKey": "WFTextActionText",
            "Text": "Paste your Shortcut Token (Settings → Apple Shortcuts)",
        }
    ],
    "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowName": "Log Sale",
    "WFWorkflowTypes": [],
    "WFWorkflowHasShortcutInputVariables": False,
}

# ── write binary plist ────────────────────────────────────────────────────────

import subprocess, tempfile

out = Path(__file__).parent.parent / "public" / "reseller-sale.shortcut"
out.parent.mkdir(exist_ok=True)

# Write unsigned plist to a temp file, then sign into the real output path
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
