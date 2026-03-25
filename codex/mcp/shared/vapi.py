from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any
from urllib import error, request

from codex.mcp.shared.common import (
    RepoContext,
    get_context_env_value,
    merged_env,
    normalize_environment,
    redact_text,
    redact_value,
)


class VapiReadError(RuntimeError):
    pass


def _sha256_text(value: str | None) -> str | None:
    if not isinstance(value, str) or value == "":
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_environment_bindings(context: RepoContext, environment: str) -> dict[str, Any]:
    normalized = normalize_environment(environment)
    path = context.root_dir / "configs" / "vapi" / "environments" / f"{normalized}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def build_vapi_config(context: RepoContext, environment: str) -> dict[str, Any]:
    normalized = normalize_environment(environment)
    env = merged_env(context)
    bindings = load_environment_bindings(context, normalized)
    api_key = get_context_env_value(env, normalized, "VAPI_API_KEY", "VAPI_API_KEY")
    if not api_key:
        raise VapiReadError(f"VAPI_API_KEY is required for {normalized}")
    base_url = (env.get("VAPI_API_BASE_URL") or "https://api.vapi.ai").strip() or "https://api.vapi.ai"
    return {
        "environment": normalized,
        "env": env,
        "bindings": bindings,
        "bindingsPath": f"configs/vapi/environments/{normalized}.json",
        "apiKey": api_key,
        "baseUrl": base_url.rstrip("/"),
    }


def api_request(
    config: dict[str, Any],
    method: str,
    path: str,
    payload: Any | None = None,
) -> Any:
    url = f"{config['baseUrl']}{path}"
    last_error: Exception | None = None

    for attempt in range(1, 6):
        body = None
        headers = {
            "Authorization": f"Bearer {config['apiKey']}",
            "Accept": "application/json",
            "User-Agent": "curl/8.5.0",
        }
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = request.Request(url, data=body, method=method, headers=headers)
        try:
            with request.urlopen(req) as response:
                raw = response.read().decode("utf-8")
            break
        except error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            retryable = exc.code in {429, 500, 502, 503, 504}
            if retryable and attempt < 5:
                time.sleep(attempt * 2)
                last_error = exc
                continue
            raise VapiReadError(f"{method} {path} failed with HTTP {exc.code}: {raw}") from exc
        except error.URLError as exc:
            if attempt < 5:
                time.sleep(attempt * 2)
                last_error = exc
                continue
            raise VapiReadError(f"{method} {path} failed: {exc}") from exc
    else:
        raise VapiReadError(f"{method} {path} failed after retries: {last_error}")

    if raw == "":
        return None

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def safe_api_request(
    config: dict[str, Any],
    method: str,
    path: str,
) -> dict[str, Any]:
    try:
        payload = api_request(config, method, path)
        return {"ok": True, "payload": payload}
    except VapiReadError as exc:
        return {"ok": False, "error": str(exc)}


def summarize_assistant_config(assistant: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    model = assistant.get("model") if isinstance(assistant.get("model"), dict) else {}
    messages = model.get("messages") if isinstance(model.get("messages"), list) else []
    system_messages = [
        item.get("content", "")
        for item in messages
        if isinstance(item, dict) and item.get("role") == "system" and isinstance(item.get("content"), str)
    ]
    transcriber = assistant.get("transcriber") if isinstance(assistant.get("transcriber"), dict) else {}
    voice = assistant.get("voice") if isinstance(assistant.get("voice"), dict) else {}
    artifact_plan = assistant.get("artifactPlan") if isinstance(assistant.get("artifactPlan"), dict) else {}
    server = assistant.get("server") if isinstance(assistant.get("server"), dict) else {}
    return redact_value(
        {
            "name": assistant.get("name"),
            "model": {
                "provider": model.get("provider"),
                "model": model.get("model"),
                "temperature": model.get("temperature"),
                "toolIds": model.get("toolIds") if isinstance(model.get("toolIds"), list) else [],
                "systemMessageCount": len(system_messages),
                "systemPromptSha256": _sha256_text("\n\n".join(system_messages)),
            },
            "transcriber": {
                "provider": transcriber.get("provider"),
                "model": transcriber.get("model"),
                "language": transcriber.get("language"),
            },
            "voice": {
                "provider": voice.get("provider"),
                "model": voice.get("model"),
                "voiceId": voice.get("voiceId"),
            },
            "artifactPlan": {
                "structuredOutputIds": artifact_plan.get("structuredOutputIds")
                if isinstance(artifact_plan.get("structuredOutputIds"), list)
                else [],
                "scorecardIds": artifact_plan.get("scorecardIds")
                if isinstance(artifact_plan.get("scorecardIds"), list)
                else [],
            },
            "server": {
                "url": server.get("url"),
            },
            "firstMessageSha256": _sha256_text(assistant.get("firstMessage")),
            "voicemailMessageSha256": _sha256_text(assistant.get("voicemailMessage")),
            "endCallMessageSha256": _sha256_text(assistant.get("endCallMessage")),
            "updatedAt": assistant.get("updatedAt"),
        },
        env=env,
    )


def summarize_tool_resource(tool: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    server = tool.get("server") if isinstance(tool.get("server"), dict) else {}
    return redact_value(
        {
            "id": tool.get("id"),
            "name": function.get("name"),
            "descriptionSha256": _sha256_text(function.get("description")),
            "serverUrl": server.get("url"),
            "updatedAt": tool.get("updatedAt"),
        },
        env=env,
    )


def summarize_structured_output_resource(resource: dict[str, Any]) -> dict[str, Any]:
    schema = resource.get("schema") if isinstance(resource.get("schema"), dict) else {}
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    return {
        "id": resource.get("id"),
        "name": resource.get("name"),
        "type": resource.get("type"),
        "propertyCount": len(properties),
        "updatedAt": resource.get("updatedAt"),
    }


def summarize_scorecard_resource(resource: dict[str, Any]) -> dict[str, Any]:
    metrics = resource.get("metrics") if isinstance(resource.get("metrics"), list) else []
    return {
        "id": resource.get("id"),
        "name": resource.get("name"),
        "metricCount": len(metrics),
        "updatedAt": resource.get("updatedAt"),
    }


def summarize_phone_number_resource(resource: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    return redact_value(
        {
            "id": resource.get("id"),
            "number": resource.get("number") or resource.get("phoneNumber"),
            "assistantId": resource.get("assistantId"),
            "name": resource.get("name"),
            "smsEnabled": resource.get("smsEnabled"),
            "updatedAt": resource.get("updatedAt"),
        },
        env=env,
    )


def summarize_call_resource(call: dict[str, Any]) -> dict[str, Any]:
    artifact = call.get("artifact") if isinstance(call.get("artifact"), dict) else {}
    structured_outputs = artifact.get("structuredOutputs") if isinstance(artifact.get("structuredOutputs"), list) else []
    scorecards = artifact.get("scorecards") if isinstance(artifact.get("scorecards"), list) else []
    return {
        "id": call.get("id"),
        "status": call.get("status"),
        "assistantId": call.get("assistantId"),
        "type": call.get("type"),
        "startedAt": call.get("startedAt"),
        "endedAt": call.get("endedAt"),
        "durationSeconds": call.get("durationSeconds"),
        "structuredOutputCount": len(structured_outputs),
        "scorecardCount": len(scorecards),
    }


def fetch_environment_runtime(context: RepoContext, environment: str) -> dict[str, Any]:
    config = build_vapi_config(context, environment)
    bindings = config["bindings"]
    env = config["env"]
    errors: list[dict[str, str]] = []

    assistant_result = safe_api_request(config, "GET", f"/assistant/{bindings['assistantId']}")
    assistant_payload = assistant_result.get("payload") if assistant_result["ok"] else None
    if not assistant_result["ok"]:
        errors.append({"surface": "assistant", "error": assistant_result["error"]})

    tool_payloads: dict[str, Any] = {}
    for tool_name, tool_id in sorted((bindings.get("toolIds") or {}).items()):
        result = safe_api_request(config, "GET", f"/tool/{tool_id}")
        if result["ok"]:
            tool_payloads[tool_name] = result["payload"]
        else:
            errors.append({"surface": f"tool:{tool_name}", "error": result["error"]})

    structured_output_payloads: list[Any] = []
    for structured_output_id in bindings.get("structuredOutputIds") or []:
        result = safe_api_request(config, "GET", f"/structured-output/{structured_output_id}")
        if result["ok"]:
            structured_output_payloads.append(result["payload"])
        else:
            errors.append({"surface": f"structured-output:{structured_output_id}", "error": result["error"]})

    scorecard_payloads: list[Any] = []
    for scorecard_id in bindings.get("scorecardIds") or []:
        result = safe_api_request(config, "GET", f"/observability/scorecard/{scorecard_id}")
        if result["ok"]:
            scorecard_payloads.append(result["payload"])
        else:
            errors.append({"surface": f"scorecard:{scorecard_id}", "error": result["error"]})

    phone_number_payload = None
    phone_number_id = bindings.get("phoneNumberId")
    if isinstance(phone_number_id, str) and phone_number_id:
        result = safe_api_request(config, "GET", f"/phone-number/{phone_number_id}")
        if result["ok"]:
            phone_number_payload = result["payload"]
        else:
            errors.append({"surface": f"phone-number:{phone_number_id}", "error": result["error"]})

    return {
        "config": config,
        "assistant": assistant_payload,
        "tools": tool_payloads,
        "structuredOutputs": structured_output_payloads,
        "scorecards": scorecard_payloads,
        "phoneNumber": phone_number_payload,
        "errors": errors,
        "assistantSummary": summarize_assistant_config(assistant_payload, env) if isinstance(assistant_payload, dict) else None,
        "toolSummaries": {
            tool_name: summarize_tool_resource(payload, env)
            for tool_name, payload in tool_payloads.items()
            if isinstance(payload, dict)
        },
        "structuredOutputSummaries": [
            summarize_structured_output_resource(payload)
            for payload in structured_output_payloads
            if isinstance(payload, dict)
        ],
        "scorecardSummaries": [
            summarize_scorecard_resource(payload)
            for payload in scorecard_payloads
            if isinstance(payload, dict)
        ],
        "phoneNumberSummary": summarize_phone_number_resource(phone_number_payload, env)
        if isinstance(phone_number_payload, dict)
        else None,
    }


def fetch_recent_calls(
    context: RepoContext,
    environment: str,
    *,
    since_hours: int = 72,
    limit: int = 10,
) -> dict[str, Any]:
    config = build_vapi_config(context, environment)
    assistant_id = config["bindings"]["assistantId"]
    response = api_request(config, "GET", f"/call?assistantId={assistant_id}&limit={limit}")
    calls = response if isinstance(response, list) else []
    cutoff_epoch = time.time() - (since_hours * 60 * 60)
    summaries: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        ended_at = call.get("endedAt")
        if isinstance(ended_at, str):
            try:
                ended_epoch = time.mktime(time.strptime(ended_at, "%Y-%m-%dT%H:%M:%S.%fZ"))
            except ValueError:
                try:
                    ended_epoch = time.mktime(time.strptime(ended_at, "%Y-%m-%dT%H:%M:%SZ"))
                except ValueError:
                    ended_epoch = None
            if ended_epoch is not None and ended_epoch < cutoff_epoch:
                continue
        summaries.append(summarize_call_resource(call))
    return {
        "environment": config["environment"],
        "assistantId": assistant_id,
        "sinceHours": since_hours,
        "limit": limit,
        "calls": summaries,
    }
