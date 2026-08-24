#!/usr/bin/env python3
"""Generate public/reseller-sale.shortcut as a binary plist.

Reverse-engineered from the working reference shortcut (iCloud link shared by user).

Key structural patterns discovered:
  - gettext for static comparison strings (e.g. "Record a Sale")
  - list action + choosefromlist(WFInput=list) for dynamic choice prompts
  - conditional: WFCondition=4 (int), WFInput={Type:Variable, Variable:{ActionOutput}}
    WFConditionalActionString = WFTextTokenString referencing gettext output
  - setvariable always has explicit WFInput with ActionOutput ref to previous action
  - choosefromlist from dictionary variable: shows keys, returns corresponding value
    (no getvalueforkey needed)
"""
import plistlib, uuid as _uuid, subprocess, tempfile
from pathlib import Path


def uid():
    return str(_uuid.uuid4()).upper()


# ── serialization helpers ──────────────────────────────────────────────────────

def plain(s):
    """Static text — WFTextTokenString."""
    return {"Value": {"attachmentsByRange": {}, "string": s},
            "WFSerializationType": "WFTextTokenString"}

def action_out(output_uuid, output_name):
    """ActionOutput ref — WFTextTokenAttachment."""
    return {"Value": {"OutputUUID": output_uuid, "Type": "ActionOutput",
                      "OutputName": output_name},
            "WFSerializationType": "WFTextTokenAttachment"}

def var_attach(name):
    """Named-variable ref — WFTextTokenAttachment."""
    return {"Value": {"VariableName": name, "Type": "Variable"},
            "WFSerializationType": "WFTextTokenAttachment"}

def var_str(name):
    """Named-variable ref embedded in WFTextTokenString."""
    return {"Value": {"string": "\ufffc",
                      "attachmentsByRange": {"{0, 1}": {
                          "Aggrandizements": [], "Type": "Variable",
                          "VariableName": name}}},
            "WFSerializationType": "WFTextTokenString"}

def var_str_prefix(prefix, name):
    """Literal prefix + named-variable ref in WFTextTokenString."""
    pos = len(prefix)
    return {"Value": {"string": prefix + "\ufffc",
                      "attachmentsByRange": {f"{{{pos}, 1}}": {
                          "Type": "Variable", "VariableName": name}}},
            "WFSerializationType": "WFTextTokenString"}

def output_str(output_uuid, output_name):
    """ActionOutput ref embedded in WFTextTokenString (for WFConditionalActionString)."""
    return {"Value": {"string": "\ufffc",
                      "attachmentsByRange": {"{0, 1}": {
                          "OutputUUID": output_uuid, "Type": "ActionOutput",
                          "OutputName": output_name}}},
            "WFSerializationType": "WFTextTokenString"}


# ── action builders ────────────────────────────────────────────────────────────

def text_act(s, custom_output_name=None):
    """Static text action. Returns (uuid, action)."""
    u = uid()
    p = {"UUID": u, "WFTextActionText": s}
    if custom_output_name:
        p["CustomOutputName"] = custom_output_name
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
               "WFWorkflowActionParameters": p}

def list_act(items):
    """List action. Returns (uuid, action)."""
    u = uid()
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.list",
               "WFWorkflowActionParameters": {"UUID": u, "WFItems": items}}

def set_var(name, from_uuid, output_name):
    """Store a previous action's output as a named variable (explicit WFInput)."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
            "WFWorkflowActionParameters": {
                "WFInput": action_out(from_uuid, output_name),
                "WFVariableName": name}}

def ask_text(prompt):
    """Ask for text input. Returns (uuid, action)."""
    u = uid()
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
               "WFWorkflowActionParameters": {
                   "UUID": u, "WFAskActionPrompt": prompt, "WFInputType": "Text"}}

def ask_num(prompt, default=None):
    """Ask for number input. Returns (uuid, action)."""
    u = uid()
    p = {"UUID": u, "WFAskActionPrompt": prompt, "WFInputType": "Number"}
    if default is not None:
        p["WFAskActionDefaultAnswer"] = str(default)
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.ask",
               "WFWorkflowActionParameters": p}

def choose_from_list_input(from_uuid, output_name, prompt=None):
    """Choose from list, WFInput = previous action output. Returns (uuid, action)."""
    u = uid()
    p = {"UUID": u,
         "WFInput": action_out(from_uuid, output_name),
         "WFChooseFromListActionSelectMultiple": False}
    if prompt:
        p["WFChooseFromListActionPrompt"] = prompt
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.choosefromlist",
               "WFWorkflowActionParameters": p}

def choose_from_dict_var(var_name, labels, prompt=None):
    """Choose from dictionary variable (shows keys, returns value). Returns (uuid, action)."""
    u = uid()
    p = {"UUID": u,
         "WFInput": var_attach(var_name),
         "WFChooseFromListActionList": [{"WFItemType": 0, "WFValue": lbl} for lbl in labels],
         "WFChooseFromListActionSelectMultiple": False}
    if prompt:
        p["WFChooseFromListActionPrompt"] = prompt
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.choosefromlist",
               "WFWorkflowActionParameters": p}

def dict_act(pairs):
    """Dictionary action. Returns (uuid, action)."""
    u = uid()
    items = [{"WFKey": plain(k), "WFItemType": 0, "WFValue": plain(v)} for k, v in pairs]
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.dictionary",
               "WFWorkflowActionParameters": {
                   "UUID": u,
                   "WFItems": {"Value": {"WFDictionaryFieldValueItems": items},
                               "WFSerializationType": "WFDictionaryFieldValue"}}}

def cond_if(gid, chosen_uuid, compare_text_uuid):
    """If block: chosen item (ActionOutput) equals compare text (ActionOutput).
    WFCondition=4 (int). WFInput wrapped as {Type:Variable, Variable:...}."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {
                "GroupingIdentifier": gid,
                "WFControlFlowMode": 0,
                "WFCondition": 4,
                "WFInput": {
                    "Type": "Variable",
                    "Variable": action_out(chosen_uuid, "Selected Item")},
                "WFConditionalActionString": output_str(compare_text_uuid, "Text")}}

def cond_else(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {"GroupingIdentifier": gid, "WFControlFlowMode": 1}}

def cond_end(gid):
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
            "WFWorkflowActionParameters": {"GroupingIdentifier": gid, "WFControlFlowMode": 2}}

def http_post(url, body_kv, show_headers=False):
    """POST JSON. Returns (uuid, action)."""
    u = uid()
    body_items = [{"WFKey": plain(k), "WFItemType": 0, "WFValue": v} for k, v in body_kv]
    return u, {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
               "WFWorkflowActionParameters": {
                   "UUID": u,
                   "WFHTTPMethod": "POST",
                   "WFURL": url,
                   "WFHTTPBodyType": "JSON",
                   "ShowHeaders": show_headers,
                   "WFHTTPHeaders": {
                       "Value": {"WFDictionaryFieldValueItems": [
                           {"WFKey": plain("Content-Type"), "WFItemType": 0,
                            "WFValue": plain("application/json")}]},
                       "WFSerializationType": "WFDictionaryFieldValue"},
                   "WFJSONValues": {
                       "Value": {"WFDictionaryFieldValueItems": body_items},
                       "WFSerializationType": "WFDictionaryFieldValue"}}}

def notify(body_prefix, var_name):
    """Show notification — no title."""
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
            "WFWorkflowActionParameters": {
                "WFNotificationActionBody": var_str_prefix(body_prefix, var_name),
                "WFNotificationActionSound": True}}


# ── shortcut definition ────────────────────────────────────────────────────────

SALE_URL  = "https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale"
BREAK_URL = "https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_breakdown"

PAYMENT_METHODS = [
    ("Cash", "cash"), ("Venmo", "venmo"), ("Cash App", "cashapp"),
    ("PayPal", "paypal"), ("Zelle", "zelle"), ("Card", "card"),
    ("Other", "other"), ("Apple Pay", "apple_pay"),
]

gid = uid()
actions = []

# ── Token (Import Question pre-fills on install) ───────────────────────────────
tok_uuid, tok_act = text_act("", custom_output_name="Token")
actions.append(tok_act)
actions.append(set_var("Token", tok_uuid, "Token"))

# ── Compare string for the If condition ───────────────────────────────────────
cmp_uuid, cmp_act = text_act("Record a Sale")
actions.append(cmp_act)

# ── Mode choice ───────────────────────────────────────────────────────────────
lst_uuid, lst_act = list_act(["Record a Sale", "Breakdown Inventory"])
actions.append(lst_act)

chosen_uuid, chosen_act = choose_from_list_input(lst_uuid, "List")
actions.append(chosen_act)

# ── If "Record a Sale" ────────────────────────────────────────────────────────
actions.append(cond_if(gid, chosen_uuid, cmp_uuid))

item_uuid, item_act = ask_text("What did you sell?")
actions.append(item_act)
actions.append(set_var("ItemName", item_uuid, "Ask for Input"))

qty_uuid, qty_act = ask_num("Quantity?", default=1)
actions.append(qty_act)
actions.append(set_var("Qty", qty_uuid, "Ask for Input"))

price_uuid, price_act = ask_num("Sale price?")
actions.append(price_act)
actions.append(set_var("SalePrice", price_uuid, "Ask for Input"))

pm_uuid, pm_act = dict_act(PAYMENT_METHODS)
actions.append(pm_act)
actions.append(set_var("PaymentMap", pm_uuid, "Dictionary"))

pay_uuid, pay_act = choose_from_dict_var(
    "PaymentMap", [lbl for lbl, _ in PAYMENT_METHODS], "Payment method?")
actions.append(pay_act)
actions.append(set_var("PayValue", pay_uuid, "Selected Item"))

_, post_sale_act = http_post(SALE_URL, [
    ("shortcut_token", var_str("Token")),
    ("item_name",      var_str("ItemName")),
    ("quantity",       var_str("Qty")),
    ("sale_price",     var_str("SalePrice")),
    ("payment_method", var_str("PayValue")),
], show_headers=True)
actions.append(post_sale_act)
actions.append(notify("Sale recorded: ", "ItemName"))

# ── Otherwise → Breakdown ─────────────────────────────────────────────────────
actions.append(cond_else(gid))

bitem_uuid, bitem_act = ask_text("What are you breaking down?")
actions.append(bitem_act)
actions.append(set_var("ItemName", bitem_uuid, "Ask for Input"))

bqty_uuid, bqty_act = ask_num("Quantity?", default=1)
actions.append(bqty_act)
actions.append(set_var("Qty", bqty_uuid, "Ask for Input"))

_, post_break_act = http_post(BREAK_URL, [
    ("shortcut_token", var_str("Token")),
    ("item_name",      var_str("ItemName")),
    ("quantity",       var_str("Qty")),
])
actions.append(post_break_act)
actions.append(notify("Breakdown recorded: ", "ItemName"))

actions.append(cond_end(gid))

# ── shortcut wrapper ──────────────────────────────────────────────────────────

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

# ── write: unsigned temp → sign → output ──────────────────────────────────────

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
