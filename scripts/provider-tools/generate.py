#!/usr/bin/env python3
"""Build a deterministic DemoDB provider contract from one pinned SQLite fixture.

The tool deliberately uses only Python's standard library. See
docs/provider-generator.md for the provider-owned ``generator`` input block.
"""

from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Any
from urllib.parse import quote


MAX_STATIC_EXPORT_BYTES = 25 * 1024 * 1024
DATABASE_SCHEMA_SHA256 = "4af5dc5f48bce1bc2ba5cb6664dd2c28adcadd818c74da0e78fe428f6f6ec55b"
DATABASE_SCHEMA_NAME = "ovdb-database-draft-1.schema.json"
CORE_ADDRESS_PATTERN = re.compile(r"^meaning://github\.com/[a-z0-9_.-]+/[a-z0-9_.-]+$")
MODEL_ENTITY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MEANING_CONCEPT_PATTERN = re.compile(r"^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$")
DATABASE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
SPDX_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9+]$")


class GenerationError(Exception):
    """A provider input cannot be represented without loss."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def safe_relative(root: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise GenerationError(f"{label} must be a non-empty relative path")
    relative = Path(value)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise GenerationError(f"{label} is unsafe: {value!r}")
    resolved = (root / relative).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise GenerationError(f"{label} escapes the provider root: {value!r}")
    return resolved


def json_bytes(value: Any) -> Any:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    return value


def json_row(row: sqlite3.Row) -> dict[str, Any]:
    return {key: json_bytes(row[key]) for key in row.keys()}


def model_type(sql_type: str) -> str:
    value = sql_type.upper()
    if "INT" in value:
        return "int"
    if any(token in value for token in ("REAL", "FLOA", "DOUB", "NUM", "DEC", "MONEY")):
        return "decimal"
    if "TIME" in value:
        return "datetime"
    if "DATE" in value:
        return "date"
    if "BLOB" in value or "BINARY" in value:
        return "document"
    return "string"


def decimal_metadata(sql_type: str) -> dict[str, Any] | None:
    """Describe the lossless DECIMAL_TEXT(p,s) provider storage convention."""
    match = re.fullmatch(r"\s*DECIMAL_TEXT\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*", sql_type, re.IGNORECASE)
    if not match:
        return None
    precision, scale = (int(value) for value in match.groups())
    if precision < 1 or precision > 1000 or scale > precision:
        raise GenerationError(f"invalid DECIMAL_TEXT precision/scale declaration {sql_type!r}")
    return {"precision": precision, "scale": scale, "storage": "text"}


def hcl_value(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ": "))


def model_files(database_id: str, config: dict[str, Any], recordsets: list[dict[str, Any]]) -> tuple[dict[str, Any], bytes, bytes, bytes]:
    model_config = config.get("model")
    meaning_config = config.get("meaning")
    if not isinstance(model_config, dict) or not isinstance(meaning_config, dict):
        raise GenerationError("generator.model and generator.meaning are required")
    module_name = model_config.get("name", database_id)
    module_id = model_config.get("moduleId")
    module_version = model_config.get("version", "0.1.0")
    if not isinstance(module_name, str) or not MODEL_ENTITY_PATTERN.fullmatch(module_name) or not isinstance(module_id, str) or not module_id or not isinstance(module_version, str):
        raise GenerationError("generator.model requires address/moduleId and an identifier-safe name")

    aliases = config.get("modelEntityAliases", {})
    if not isinstance(aliases, dict):
        raise GenerationError("generator.modelEntityAliases must be an object")
    property_aliases = config.get("modelPropertyAliases", {})
    if not isinstance(property_aliases, dict):
        raise GenerationError("generator.modelPropertyAliases must be an object")
    tables = [item for item in recordsets if item["kind"] == "table"]
    table_names = {item["name"] for item in tables}
    unknown_entity_aliases = set(aliases) - table_names
    unknown_property_aliases = set(property_aliases) - table_names
    if unknown_entity_aliases or unknown_property_aliases:
        unknown = sorted(unknown_entity_aliases | unknown_property_aliases)
        raise GenerationError(f"ModelSpec aliases reference unknown native tables: {', '.join(unknown)}")
    entities: dict[str, Any] = {}
    native_to_entity: dict[str, str] = {}
    native_to_property: dict[str, dict[str, str]] = {}
    for table in tables:
        native = table["name"]
        entity_name = aliases.get(native, re.sub(r"[^A-Za-z0-9_]", "_", native))
        if not isinstance(entity_name, str) or not MODEL_ENTITY_PATTERN.fullmatch(entity_name):
            raise GenerationError(f"ModelSpec entity for {native!r} is not an identifier: {entity_name!r}")
        if entity_name in native_to_entity.values():
            raise GenerationError(f"two native tables map to ModelSpec entity {entity_name!r}")
        native_to_entity[native] = entity_name
        table_aliases = property_aliases.get(native, {})
        if not isinstance(table_aliases, dict):
            raise GenerationError(f"ModelSpec property aliases for {native!r} must be an object")
        mapped_properties: dict[str, str] = {}
        native_columns = {column["name"] for column in table["columns"]}
        unknown_columns = set(table_aliases) - native_columns
        if unknown_columns:
            raise GenerationError(f"ModelSpec property aliases for {native!r} reference unknown columns: {', '.join(sorted(unknown_columns))}")
        for column in table["columns"]:
            native_column = column["name"]
            property_name = table_aliases.get(native_column, re.sub(r"[^A-Za-z0-9_]", "_", native_column))
            if isinstance(property_name, str) and property_name and property_name[0].isdigit():
                property_name = "_" + property_name
            if not isinstance(property_name, str) or not MODEL_ENTITY_PATTERN.fullmatch(property_name):
                raise GenerationError(f"ModelSpec property for {native}.{native_column} is not an identifier: {property_name!r}")
            if property_name in mapped_properties.values():
                raise GenerationError(f"two native columns in {native!r} map to ModelSpec property {property_name!r}; author an explicit alias")
            mapped_properties[native_column] = property_name
        native_to_property[native] = mapped_properties

    for table in tables:
        if table["name"] not in native_to_entity:
            continue
        entity_name = native_to_entity[table["name"]]
        keys = [native_to_property[table["name"]][item["column"]] for item in sorted(table["primaryKey"], key=lambda item: item["position"])]
        foreign_targets: dict[str, str] = {}
        for fk in table["foreignKeys"]:
            target = native_to_entity.get(fk["table"])
            if target is None:
                raise GenerationError(f"foreign key from {table['name']}.{fk['column']} targets an unmodeled table {fk['table']!r}")
            previous = foreign_targets.get(fk["column"])
            if previous is not None and previous != target:
                raise GenerationError(f"foreign-key column {table['name']}.{fk['column']} targets multiple entities; author this model manually")
            foreign_targets[fk["column"]] = target
        properties: dict[str, Any] = {}
        for column in table["columns"]:
            definition: dict[str, Any] = {"required": not column["nullable"]}
            if column["name"] in foreign_targets:
                definition["entity"] = foreign_targets[column["name"]]
            else:
                definition["type"] = model_type(column["type"])
            if not definition["required"]:
                del definition["required"]
            model_property = native_to_property[table["name"]][column["name"]]
            if model_property != column["name"]:
                column["modelProperty"] = model_property
            properties[model_property] = definition
        definition: dict[str, Any] = {"properties": properties}
        if keys:
            definition = {"key": keys, **definition}
        entities[entity_name] = definition

    model = {
        "modelspec": "1.0-draft",
        "module": {"id": module_id, "name": module_name, "version": module_version},
        "entities": entities,
    }
    hcl_lines = ["# Generated from the provider's pinned SQLite source fixture.", "# Edit the generator inputs, then regenerate; do not edit this file by hand."]
    emit_model_spdx = config.get("emitModelSpdxLicense", False)
    if not isinstance(emit_model_spdx, bool):
        raise GenerationError("generator.emitModelSpdxLicense must be a boolean")
    if emit_model_spdx:
        licences = config.get("licences")
        model_license = licences.get("model") if isinstance(licences, dict) else None
        if not isinstance(model_license, str) or not SPDX_IDENTIFIER_PATTERN.fullmatch(model_license):
            raise GenerationError("generator.emitModelSpdxLicense requires generator.licences.model to be an SPDX identifier")
        hcl_lines.append(f"# SPDX-License-Identifier: {model_license}")
    for entity_name, entity in entities.items():
        hcl_lines += ["", f"entity {hcl_value(entity_name)} {{"]
        if "key" in entity:
            hcl_lines.append(f"  key = {hcl_value(entity['key'])}")
        for property_name, definition in entity["properties"].items():
            hcl_lines += ["", f"  property {hcl_value(property_name)} {{"]
            for key, value in definition.items():
                hcl_lines.append(f"    {key} = {hcl_value(value)}")
            hcl_lines.append("  }")
        hcl_lines.append("}")
    hcl = ("\n".join(hcl_lines) + "\n").encode("utf-8")

    meaning = build_meaning(database_id, meaning_config, native_to_entity, native_to_property)
    return model, canonical_json(model), hcl, canonical_json(meaning)


def build_meaning(database_id: str, config: dict[str, Any], native_to_entity: dict[str, str], native_to_property: dict[str, dict[str, str]]) -> dict[str, Any]:
    graph_id = config.get("id", database_id)
    address = config.get("address")
    name = config.get("name")
    description = config.get("description")
    license_id = config.get("license")
    core = config.get("core")
    concepts = config.get("concepts")
    sources = config.get("sources", [])
    if not isinstance(graph_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", graph_id):
        raise GenerationError("generator.meaning.id must be a lower-case registry ID")
    if not isinstance(address, str) or not address.startswith("meaning://github.com/"):
        raise GenerationError("generator.meaning.address must be a MeaningGraph repository address")
    if not all(isinstance(item, str) and item for item in (name, description, license_id)):
        raise GenerationError("generator.meaning requires name, description, and license")
    if not isinstance(core, dict) or not isinstance(core.get("address"), str) or not CORE_ADDRESS_PATTERN.fullmatch(core["address"]):
        raise GenerationError("generator.meaning.core.address must be a GitHub MeaningGraph address")
    core_revision = core.get("revision")
    if not isinstance(core_revision, str) or not re.fullmatch(r"[0-9a-f]{40}", core_revision):
        raise GenerationError("generator.meaning.core.revision must be a full immutable commit SHA")
    if not isinstance(concepts, list):
        raise GenerationError("generator.meaning.concepts must be a list")
    if not isinstance(sources, list):
        raise GenerationError("generator.meaning.sources must be a list")
    source_ids: set[str] = set()
    normalized_sources = []
    for source in sources:
        if not isinstance(source, dict) or not all(isinstance(source.get(key), str) and source[key] for key in ("id", "provider", "dataset")):
            raise GenerationError("each meaning source requires id, provider, and dataset")
        if set(source) - {"id", "provider", "dataset", "title", "year", "license", "url", "note"}:
            raise GenerationError(f"meaning source {source.get('id')!r} has unsupported fields")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", source["id"]) or source["id"] in source_ids:
            raise GenerationError(f"invalid or duplicate meaning source id: {source['id']!r}")
        source_ids.add(source["id"])
        normalized_sources.append(source)
    concept_ids = {item.get("id") for item in concepts if isinstance(item, dict)}
    generated = []
    seen: set[str] = set()
    local_extends: dict[str, str] = {}
    for concept in concepts:
        if not isinstance(concept, dict):
            raise GenerationError("every meaning concept must be an object")
        concept_id = concept.get("id")
        allowed_concept_fields = {"id", "kind", "label", "description", "labels", "synonyms", "unit", "values", "source", "measure", "extends", "valuesOf", "of", "bindings"}
        unknown_concept_fields = set(concept) - allowed_concept_fields
        if unknown_concept_fields:
            raise GenerationError(f"meaning concept {concept_id!r} has unsupported fields: {', '.join(sorted(unknown_concept_fields))}")
        kind = concept.get("kind")
        label = concept.get("label")
        concept_description = concept.get("description")
        if not isinstance(concept_id, str) or len(concept_id) > 80 or not MEANING_CONCEPT_PATTERN.fullmatch(concept_id) or concept_id in seen:
            raise GenerationError(f"invalid or duplicate meaning concept id: {concept_id!r}")
        seen.add(concept_id)
        if kind not in ("entity", "attribute", "measure", "dimension") or not all(isinstance(value, str) and value for value in (label, concept_description)):
            raise GenerationError(f"meaning concept {concept_id!r} requires kind, label, and description")
        result: dict[str, Any] = {"id": concept_id, "kind": kind, "description": concept_description, "labels": {"en": label}}
        labels = concept.get("labels")
        if labels is not None:
            if not isinstance(labels, dict) or not all(isinstance(key, str) and isinstance(value, str) and value for key, value in labels.items()) or "en" not in labels:
                raise GenerationError(f"meaning concept {concept_id!r} labels must be non-empty strings and include en")
            result["labels"] = labels
        synonyms = concept.get("synonyms")
        if synonyms is not None:
            validate_words(synonyms, f"meaning concept {concept_id!r} synonyms")
            result["synonyms"] = synonyms
        unit = concept.get("unit")
        if unit is not None:
            if not isinstance(unit, str) or not unit:
                raise GenerationError(f"meaning concept {concept_id!r} unit must be a non-empty string")
            result["unit"] = unit
        values = concept.get("values")
        if values is not None:
            if not isinstance(values, list) or not values:
                raise GenerationError(f"meaning concept {concept_id!r} values must be a non-empty list")
            normalized_values = []
            value_ids: set[str] = set()
            for value in values:
                if not isinstance(value, dict) or set(value) - {"id", "labels", "aliases", "codes"}:
                    raise GenerationError(f"meaning concept {concept_id!r} contains an invalid value")
                value_id = value.get("id")
                if not isinstance(value_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value_id) or value_id in value_ids:
                    raise GenerationError(f"meaning concept {concept_id!r} contains an invalid or duplicate value id")
                value_ids.add(value_id)
                value_labels = value.get("labels")
                if not isinstance(value_labels, dict) or "en" not in value_labels or not all(isinstance(key, str) and isinstance(label_value, str) and label_value for key, label_value in value_labels.items()):
                    raise GenerationError(f"meaning value {value_id!r} requires non-empty labels including en")
                if "aliases" in value:
                    validate_words(value["aliases"], f"meaning value {value_id!r} aliases")
                codes = value.get("codes", {})
                if not isinstance(codes, dict) or any(not re.fullmatch(r"[a-z][a-z0-9-]*", key) or not isinstance(code, str) or not code for key, code in codes.items()):
                    raise GenerationError(f"meaning value {value_id!r} codes are invalid")
                normalized_values.append(value)
            result["values"] = normalized_values
        source_id = concept.get("source")
        if source_id is not None:
            if source_id not in source_ids:
                raise GenerationError(f"meaning concept {concept_id!r} references unknown source {source_id!r}")
            result["source"] = source_id
        for field in ("extends", "valuesOf", "of"):
            target = concept.get(field)
            if target is not None:
                target = normalize_concept_ref(target, concept_ids, config.get("core", {}), f"meaning concept {concept_id!r} {field}")
                if target == concept_id:
                    raise GenerationError(f"meaning concept {concept_id!r} cannot reference itself via {field}; use a pinned meaning:// URL for a core concept with the same ID")
                if field == "extends" and target in concept_ids:
                    local_extends[concept_id] = target
                key = {"valuesOf": "values-of"}.get(field, field)
                result[key] = target
        measure = concept.get("measure")
        if kind == "measure" and (not isinstance(measure, dict) or not isinstance(measure.get("formula"), str) or not measure["formula"]):
            raise GenerationError(f"measure concept {concept_id!r} requires generator measure.formula")
        if measure is not None:
            if not isinstance(measure, dict) or set(measure) - {"formula", "aggregation", "inputs", "dimensions", "scale", "query"}:
                raise GenerationError(f"measure concept {concept_id!r} has unsupported measure fields")
            measure_output = dict(measure)
            if "aggregation" in measure and measure["aggregation"] not in ("sum", "count", "average", "min", "max", "none"):
                raise GenerationError(f"measure concept {concept_id!r} has an invalid aggregation")
            if "formula" in measure and (not isinstance(measure["formula"], str) or not measure["formula"]):
                raise GenerationError(f"measure concept {concept_id!r} formula must be a non-empty string")
            for field in ("inputs", "dimensions"):
                if field in measure:
                    if not isinstance(measure[field], list):
                        raise GenerationError(f"measure concept {concept_id!r} {field} must be a list")
                    measure_output[field] = [normalize_concept_ref(ref, concept_ids, core, f"measure {concept_id!r} {field}") for ref in measure[field]]
            result["measure"] = measure_output
        bindings = concept.get("bindings", [])
        if not isinstance(bindings, list) or not bindings:
            raise GenerationError(f"meaning concept {concept_id!r} requires at least one model binding")
        out_bindings = []
        for binding in bindings:
            if not isinstance(binding, dict):
                raise GenerationError(f"meaning concept {concept_id!r} has an invalid binding")
            unknown_binding_fields = set(binding) - {"recordset", "role", "property", "match", "note"}
            if unknown_binding_fields:
                raise GenerationError(f"meaning concept {concept_id!r} binding has unsupported fields: {', '.join(sorted(unknown_binding_fields))}")
            recordset = binding.get("recordset")
            role = binding.get("role")
            if recordset not in native_to_entity or role not in ("entity", "identifier", "display-name", "foreign-key", "value"):
                raise GenerationError(f"meaning concept {concept_id!r} binding has unknown recordset or role")
            model_binding: dict[str, Any] = {"model": f"modelspec:///{database_id}.{native_to_entity[recordset]}", "role": role}
            prop = binding.get("property")
            if role != "entity" and not prop:
                raise GenerationError(f"meaning concept {concept_id!r} binding with role {role!r} requires property")
            if prop is not None:
                if not isinstance(prop, str) or prop not in native_to_property[recordset]:
                    raise GenerationError(f"meaning concept {concept_id!r} references unknown native property {recordset}.{prop}")
                model_binding["property"] = native_to_property[recordset][prop]
            for optional in ("match", "note"):
                if optional in binding:
                    if optional == "match" and (role not in ("value", "display-name") or not isinstance(binding[optional], str) or not re.fullmatch(r"(labels|codes\.[a-z][a-z0-9-]*)", binding[optional])):
                        raise GenerationError(f"meaning concept {concept_id!r} binding has an invalid match rule")
                    if optional == "note" and (not isinstance(binding[optional], str) or not binding[optional]):
                        raise GenerationError(f"meaning concept {concept_id!r} binding note must be a non-empty string")
                    model_binding[optional] = binding[optional]
            out_bindings.append(model_binding)
        result["bindings"] = out_bindings
        generated.append(result)
    for start in local_extends:
        visited: set[str] = set()
        current = start
        while current in local_extends:
            if current in visited:
                raise GenerationError(f"local MeaningGraph extends cycle includes {current!r}")
            visited.add(current)
            current = local_extends[current]
    return {
        "format": "meaning/draft-1",
        "id": graph_id,
        "name": name,
        "description": description,
        "license": license_id,
        "models": {database_id: f"{database_id}.modelspec.hcl"},
        **({"sources": normalized_sources} if normalized_sources else {}),
        "concepts": generated,
    }


def normalize_concept_ref(value: Any, local_ids: set[Any], core: Any, label: str) -> str:
    bare_pattern = re.compile(r"^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$")
    external_pattern = re.compile(r"^meaning://[A-Za-z0-9.-]+(/[A-Za-z0-9._-]+)+/[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\?ref=[A-Za-z0-9._/-]+)?$")
    if isinstance(value, str) and bare_pattern.fullmatch(value):
        if value in local_ids:
            return value
        if isinstance(core, dict) and isinstance(core.get("address"), str) and isinstance(core.get("revision"), str) and re.fullmatch(r"[0-9a-f]{40}", core["revision"]):
            core_address = core["address"].rstrip("/")
            if CORE_ADDRESS_PATTERN.fullmatch(core_address):
                return f"{core_address}/{value}?ref={core['revision']}"
    if isinstance(value, str) and external_pattern.fullmatch(value):
        return value
    raise GenerationError(f"{label} must reference a local concept id, a pinned core concept, or a valid MeaningGraph URL")


def validate_words(value: Any, label: str) -> None:
    if not isinstance(value, dict) or not value:
        raise GenerationError(f"{label} must map language tags to non-empty word lists")
    for language, words in value.items():
        if not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}(-[A-Z]{2})?", language):
            raise GenerationError(f"{label} has an invalid language tag")
        if not isinstance(words, list) or not words or any(not isinstance(word, str) or not word for word in words):
            raise GenerationError(f"{label} must contain non-empty word lists")


def get_ordered_rows(connection: sqlite3.Connection, name: str) -> sqlite3.Cursor:
    columns = [row[1] for row in connection.execute(f"PRAGMA table_xinfo({quote_identifier(name)})")]
    if not columns:
        columns = [item[0] for item in connection.execute(f"SELECT * FROM {quote_identifier(name)} LIMIT 0").description or []]
    order = ", ".join(quote_identifier(value) for value in columns)
    return connection.execute(f"SELECT * FROM {quote_identifier(name)} ORDER BY {order}")


def recordset_info(connection: sqlite3.Connection, name: str, kind: str, description: str) -> dict[str, Any]:
    quoted = quote_identifier(name)
    if kind == "table":
        # table_xinfo includes generated/computed columns omitted by table_info.
        raw_columns = connection.execute(f"PRAGMA table_xinfo({quoted})").fetchall()
        columns = [{
            "name": column[1],
            "type": column[2] or "",
            "nullable": not bool(column[3]),
            "primaryKey": bool(column[5]),
            "primaryKeyOrder": column[5],
            "primaryKeyPosition": column[5] or None,
            "defaultValue": column[4],
            **({"decimal": decimal} if (decimal := decimal_metadata(column[2] or "")) else {}),
            **({"generated": "virtual" if column[6] == 2 else "stored"} if column[6] in (2, 3) else {}),
            **({"hidden": True} if column[6] == 1 else {}),
        } for column in raw_columns]
        primary_key = sorted(
            ({"column": column["name"], "position": column["primaryKeyPosition"]} for column in columns if column["primaryKey"]),
            key=lambda item: item["position"],
        )
        foreign_keys = []
        unique_keys = []
        unique_indexes = []
        indexes = sorted(connection.execute(f"PRAGMA index_list({quoted})"), key=lambda row: row[1])
        for index in indexes:
            if not index[2]:
                continue
            index_name = index[1]
            index_sql_row = connection.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (index_name,)).fetchone()
            index_sql = index_sql_row[0] if index_sql_row else None
            terms = []
            for term in connection.execute(f"PRAGMA index_xinfo({quote_identifier(index_name)})"):
                if not term[5]:
                    continue
                terms.append({
                    "position": term[0],
                    "column": term[2],
                    "expression": term[2] is None,
                    "descending": bool(term[3]),
                    "collation": term[4],
                })
            unique_index = {
                "name": index_name,
                "origin": index[3],
                "partial": bool(index[4]),
                "columns": terms,
                "sql": index_sql,
            }
            unique_indexes.append(unique_index)
            if index[3] != "pk" and not index[4] and terms and all(term["column"] is not None for term in terms):
                unique_keys.append({
                    "name": index_name,
                    "origin": index[3],
                    "columns": [term["column"] for term in terms],
                })
        fk_rows = sorted(connection.execute(f"PRAGMA foreign_key_list({quoted})"), key=lambda row: (row[0], row[1]))
        target_primary_keys: dict[str, list[str]] = {}
        for fk in fk_rows:
            referenced_column = fk[4]
            if referenced_column is None:
                target_name = fk[2]
                if target_name not in target_primary_keys:
                    target_quoted = quote_identifier(target_name)
                    target_primary_keys[target_name] = [
                        item[1] for item in sorted(
                            (column for column in connection.execute(f"PRAGMA table_xinfo({target_quoted})") if column[5]),
                            key=lambda column: column[5],
                        )
                    ]
                target_keys = target_primary_keys[target_name]
                if fk[1] >= len(target_keys):
                    raise GenerationError(f"foreign key {name!r} references {target_name!r} without a resolvable primary key")
                referenced_column = target_keys[fk[1]]
            foreign_keys.append({
                "column": fk[3], "table": fk[2], "referencedColumn": referenced_column,
                "constraint": fk[0], "position": fk[1],
                "onUpdate": fk[5], "onDelete": fk[6], "match": fk[7],
            })
        sample_cursor = connection.execute(f"SELECT * FROM {quoted} ORDER BY " + ", ".join(quote_identifier(item["name"]) for item in columns) + " LIMIT 12")
        row_count = connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        view_sql = None
    else:
        cursor = connection.execute(f"SELECT * FROM {quoted} LIMIT 0")
        columns = [{"name": column[0], "type": column[1] or "", "nullable": True, "primaryKey": False, "primaryKeyOrder": 0, "primaryKeyPosition": None, "defaultValue": None} for column in cursor.description or []]
        primary_key = []
        foreign_keys = []
        unique_keys = []
        unique_indexes = []
        sample_cursor = connection.execute(f"SELECT * FROM {quoted} ORDER BY " + ", ".join(quote_identifier(item["name"]) for item in columns) + " LIMIT 12")
        row_count = connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        row = connection.execute("SELECT sql FROM sqlite_master WHERE type='view' AND name=?", (name,)).fetchone()
        view_sql = row[0] if row else None
    table_row = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() if kind == "table" else None
    return {
        "name": name,
        "modelEntity": None,
        "modelRecordset": None,
        "kind": kind,
        "description": description,
        "columns": columns,
        "primaryKey": primary_key,
        **({"uniqueKeys": unique_keys, "uniqueIndexes": unique_indexes} if kind == "table" else {}),
        "foreignKeys": foreign_keys,
        "rowCount": row_count,
        "viewSql": view_sql,
        "tableSql": table_row[0] if table_row else None,
        "rows": [json_row(row) for row in sample_cursor.fetchall()],
    }


def verify_sqlite_source(connection: sqlite3.Connection) -> None:
    integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    if integrity != ["ok"]:
        raise GenerationError(f"source SQLite integrity_check failed: {'; '.join(integrity[:5])}")
    violations = connection.execute("PRAGMA foreign_key_check").fetchmany(5)
    if violations:
        details = "; ".join(
            f"{row[0]} rowid={row[1]} target={row[2]} constraint={row[3]}" for row in violations
        )
        raise GenerationError(f"source SQLite foreign_key_check found violations: {details}")


def native_source_views(
    root: Path,
    config: dict[str, Any],
    schema_tables: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], tuple[str, bytes] | None]:
    """Load source-native view definitions without making them SQLite exports."""
    configured_path = config.get("nativeObjectsFile")
    if configured_path is None:
        return [], None
    path = safe_relative(root, configured_path, "generator.nativeObjectsFile")
    if not path.is_file():
        raise GenerationError(f"generator.nativeObjectsFile does not exist: {configured_path}")
    content = path.read_bytes()
    if len(content) > MAX_STATIC_EXPORT_BYTES:
        raise GenerationError(f"generator.nativeObjectsFile exceeds the {MAX_STATIC_EXPORT_BYTES}-byte static file limit")
    try:
        document = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GenerationError(f"generator.nativeObjectsFile is not valid UTF-8 JSON: {error}") from error
    if not isinstance(document, dict) or document.get("format") != "demodb-native-sqlserver-metadata/draft-1":
        raise GenerationError("generator.nativeObjectsFile must use demodb-native-sqlserver-metadata/draft-1")
    views = document.get("views")
    if not isinstance(views, list):
        raise GenerationError("generator.nativeObjectsFile.views must be an array")

    sqlite_views = {item["name"]: item["viewSql"] for item in schema_tables if item["kind"] == "view"}
    seen_recordsets: set[str] = set()
    preserved: list[dict[str, Any]] = []

    def normalized_sql(value: str) -> str:
        return value.strip().rstrip(";").rstrip()

    for index, view in enumerate(views):
        if not isinstance(view, dict):
            raise GenerationError(f"native source view at index {index} must be an object")
        for field in ("name", "recordset", "schema", "sourceDefinition", "sqliteCompatibility"):
            if not isinstance(view.get(field), str) or not view[field]:
                raise GenerationError(f"native source view at index {index} requires non-empty string {field}")
        if "rows" in view:
            raise GenerationError(f"native source view {view['name']!r} must not contain row samples")
        name = view["name"]
        recordset = view["recordset"]
        schema_name = view["schema"]
        if recordset != f"{schema_name}.{name}":
            raise GenerationError(f"native source view {name!r} recordset must be schema-qualified as {schema_name}.{name}")
        if recordset in seen_recordsets:
            raise GenerationError(f"duplicate native source view recordset: {recordset!r}")
        seen_recordsets.add(recordset)
        compatibility = view["sqliteCompatibility"]
        if compatibility not in ("compatible", "unsupported"):
            raise GenerationError(f"native source view {name!r} has unsupported sqliteCompatibility {compatibility!r}")
        if "limitation" in view and not isinstance(view["limitation"], str):
            raise GenerationError(f"native source view {name!r} limitation must be a string")
        if "sqliteDefinition" in view and not isinstance(view["sqliteDefinition"], str):
            raise GenerationError(f"native source view {name!r} sqliteDefinition must be a string")
        actual_sqlite_definition = sqlite_views.get(recordset)
        available = actual_sqlite_definition is not None
        if compatibility == "compatible":
            expected_definition = view.get("sqliteDefinition")
            if not available or not expected_definition or normalized_sql(actual_sqlite_definition) != normalized_sql(expected_definition):
                raise GenerationError(f"native source view {name!r} is marked compatible but its SQLite definition does not match the executable SQLite view")
        if compatibility == "unsupported" and available:
            raise GenerationError(f"native source view {name!r} is marked unsupported but appears as an executable SQLite view")
        preserved.append({**view, "availableAsSqliteView": available})
    return preserved, (path.relative_to(root).as_posix(), content)


def write_export(path: Path, contents: bytes) -> dict[str, Any]:
    if len(contents) > MAX_STATIC_EXPORT_BYTES:
        raise GenerationError(
            f"static export {path.name!r} is {len(contents)} bytes (limit {MAX_STATIC_EXPORT_BYTES}); "
            "use a compressed download or paged OVDB delivery, and preserve the full source data"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return {"bytes": len(contents), "sha256": sha256(contents)}


def deterministic_gzip(contents: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=output, mtime=0) as stream:
        stream.write(contents)
    return output.getvalue()


def compress_large_exports(outputs: dict[str, bytes], exports: list[dict[str, Any]]) -> None:
    """Store oversized logical exports as deterministic gzip, split at the asset limit."""
    for export in exports:
        logical_path = export["path"]
        contents = outputs[logical_path]
        if len(contents) <= MAX_STATIC_EXPORT_BYTES:
            continue
        encoded_path = f"{logical_path}.gz"
        encoded = deterministic_gzip(contents)
        del outputs[logical_path]
        compressed_metadata = {
            "encodedPath": encoded_path,
            "compression": "gzip",
            "bytes": len(encoded),
            "sha256": sha256(encoded),
            "decodedBytes": len(contents),
            "decodedSha256": sha256(contents),
        }
        if len(encoded) <= MAX_STATIC_EXPORT_BYTES:
            outputs[encoded_path] = encoded
        else:
            chunks = []
            for index, start in enumerate(range(0, len(encoded), MAX_STATIC_EXPORT_BYTES), 1):
                chunk_path = f"{encoded_path}.part-{index:04d}"
                chunk = encoded[start : start + MAX_STATIC_EXPORT_BYTES]
                outputs[chunk_path] = chunk
                chunks.append({"path": chunk_path, "bytes": len(chunk), "sha256": sha256(chunk)})
            compressed_metadata["chunks"] = chunks
        export.update(compressed_metadata)


def dump_csv(connection: sqlite3.Connection, name: str, path: Path) -> bytes:
    output = io.StringIO(newline="")
    cursor = get_ordered_rows(connection, name)
    columns = [item[0] for item in cursor.description or []]
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(columns)
    for row in cursor:
        writer.writerow([base64.b64encode(value).decode("ascii") if isinstance(value, bytes) else value for value in row])
    return output.getvalue().encode("utf-8")


def dump_json(connection: sqlite3.Connection, name: str, path: Path) -> bytes:
    output = io.StringIO()
    output.write("[\n")
    cursor = get_ordered_rows(connection, name)
    first = True
    for row in cursor:
        if not first:
            output.write(",\n")
        output.write("  " + json.dumps(json_row(row), ensure_ascii=False, allow_nan=False, separators=(",", ": ")))
        first = False
    output.write("\n]\n")
    return output.getvalue().encode("utf-8")


def dump_sql(connection: sqlite3.Connection, path: Path) -> bytes:
    output = bytearray()
    for statement in connection.iterdump():
        line = (statement + "\n").encode("utf-8")
        output.extend(line)
    return bytes(output)


def ovdb_files(root: Path, manifest: dict[str, Any], config: dict[str, Any], schema: dict[str, Any], source_digest: str, schema_bytes: bytes, model: dict[str, Any]) -> tuple[bytes, bytes]:
    dbid = manifest["id"]
    ovdb = config.get("ovdb")
    publisher = config.get("publisher")
    licences = config.get("licences")
    model_config = config["model"]
    meaning_config = config["meaning"]
    if not all(isinstance(value, dict) for value in (ovdb, publisher, licences)):
        raise GenerationError("generator.ovdb, generator.publisher, and generator.licences are required objects")
    for key in ("name", "url", "repository"):
        if not isinstance(publisher.get(key), str) or not publisher[key]:
            raise GenerationError(f"generator.publisher.{key} is required")
    for key in ("model", "meaning"):
        if not isinstance(licences.get(key), str) or not licences[key]:
            raise GenerationError(f"generator.licences.{key} is required")
    data_license = manifest.get("source", {}).get("license")
    if not isinstance(data_license, str) or not data_license:
        raise GenerationError("manifest.source.license must identify the source data license")
    deployment = ovdb.get("deployment")
    if not isinstance(deployment, dict) or not all(isinstance(deployment.get(key), str) and deployment[key] for key in ("engine", "url", "discovery")):
        raise GenerationError("generator.ovdb.deployment requires engine, url, and discovery")
    served_tables = ovdb.get("recordsets")
    tables = {item["name"]: item for item in schema["tables"] if item["kind"] == "table"}
    if not isinstance(served_tables, list) or not served_tables or any(name not in tables for name in served_tables):
        raise GenerationError("generator.ovdb.recordsets must list one or more native table names")
    if len(set(served_tables)) != len(served_tables):
        raise GenerationError("generator.ovdb.recordsets contains duplicates")
    capabilities = manifest.get("capabilities", {}).get("ovdb", {})
    public_id = capabilities.get("canonicalUrl")
    server_id = capabilities.get("serverId")
    base_url = capabilities.get("serverDbBaseUrl")
    api_url = capabilities.get("connection")
    expected_identity = f"https://demodb.dev/{dbid}/"
    if (public_id, server_id, base_url, api_url) != (
        expected_identity,
        "https://demodb.dev/ovdb",
        f"https://demodb.dev/ovdb/db/{dbid}/",
        f"https://demodb.dev/ovdb/v1/databases/{dbid}",
    ):
        raise GenerationError("manifest.capabilities.ovdb must include canonicalUrl, serverId, serverDbBaseUrl, and connection")
    host = manifest.get("siteHost")
    if not isinstance(host, str) or not host.endswith(".demodb.dev"):
        raise GenerationError("manifest.siteHost must be the provider's public .demodb.dev host")
    model_address = model_config.get("address")
    if not isinstance(model_address, str) or not model_address.startswith("modelspec://"):
        raise GenerationError("generator.model.address must be a ModelSpec address")
    meaning_address = meaning_config.get("address")
    meaning_id = meaning_config.get("id")
    if not isinstance(meaning_address, str):
        raise GenerationError("generator.meaning.address is required")
    model_json_path = f"model/{dbid}.modelspec.json"
    model_hcl_path = f"model/{dbid}.modelspec.hcl"
    meaning_path = f"model/{dbid}.meaning.yaml"
    model_href = f"https://{host}/model/{dbid}.modelspec.json"
    meaning_href = f"https://{host}/model/{dbid}.meaning.yaml"
    aliases = config.get("modelEntityAliases", {})
    if not isinstance(aliases, dict):
        raise GenerationError("generator.modelEntityAliases must be an object")
    entities = model.get("entities", {})
    recordset_entities = {
        name: aliases.get(name, re.sub(r"[^A-Za-z0-9_]", "_", name))
        for name in served_tables
        if aliases.get(name, re.sub(r"[^A-Za-z0-9_]", "_", name)) in entities
    }
    ovdb_yaml = {
        "format": "ovdb-manifest/draft-1",
        "id": dbid,
        "title": manifest["name"],
        "description": manifest["description"],
        "homepage": f"https://{host}/",
        "url": public_id,
        "deployment": deployment,
        "model": {"address": model_address, "modelspec": model_json_path, "hcl": model_hcl_path},
        "meaning": {"file": meaning_path, "graph": {"id": meaning_id, "address": meaning_address}},
        "publisher": publisher,
        "licences": {"data": data_license, **licences},
        "recordsets": served_tables,
        "recordset_entities": {name: entity for name, entity in recordset_entities.items() if entity != name},
    }
    # JSON is valid YAML 1.2, which avoids a YAML package dependency in provider repositories.
    ovdb_yaml_bytes = canonical_json(ovdb_yaml)
    public_recordsets = []
    for name in served_tables:
        table = tables[name]
        public_recordset = {
            "name": name,
            "kind": "table",
            "description": table["description"],
            "rowCount": table["rowCount"],
            "columns": [{key: column[key] for key in ("name", "type", "nullable", "primaryKey", "primaryKeyPosition", "defaultValue", "decimal") if key in column} for column in table["columns"]],
            "primaryKey": table["primaryKey"],
            "foreignKeys": [{key: fk[key] for key in ("column", "table", "referencedColumn", "constraint", "position")} for fk in table["foreignKeys"]],
        }
        if table.get("modelEntity"):
            public_recordset["modelEntity"] = table["modelEntity"]
        public_recordsets.append(public_recordset)
    descriptor = {
        "format": "ovdb-database/draft-1",
        "id": public_id,
        "localId": dbid,
        "serverId": server_id,
        "serverDbBaseUrl": base_url,
        "title": manifest["name"],
        "description": manifest["description"],
        "homepage": f"https://{host}/",
        "apiUrl": api_url,
        "capabilities": {"read": True, "query": ovdb.get("query") is True, "write": False},
        "deployment": deployment,
        "model": {"id": model_address, "url": model_href, "hclUrl": f"https://{host}/model/{dbid}.modelspec.hcl"},
        "meaning": {"id": meaning_address, "url": meaning_href},
        "publisher": publisher,
        "provenance": {
            "repository": manifest["source"]["repository"],
            "revision": manifest["source"]["revision"],
            "path": manifest["source"].get("path", manifest["dataFile"]),
            "sha256": source_digest,
            "license": manifest["source"].get("license", "unknown"),
            "notes": " ".join(filter(None, [
                manifest["source"].get("notes", ""),
                "The sha256 identifies the decoded SQLite fixture; source.inputSha256 identifies the compressed dataFile bytes."
                if manifest["source"].get("inputCompression") == "gzip" else (
                    f"The sha256 identifies the generated SQLite fixture at {manifest['dataFile']}; recipe inputs are identified separately by the provider manifest."
                    if manifest["source"].get("path") not in (None, manifest["dataFile"]) else ""
                ),
            ])),
        },
        "licences": {"data": data_license, **licences},
        "recordsets": public_recordsets,
    }
    schema_document = json.loads(schema_bytes)
    validate_database_descriptor_shape(descriptor, schema_document)
    return ovdb_yaml_bytes, canonical_json(descriptor)


def validate_database_descriptor_shape(value: dict[str, Any], schema: dict[str, Any]) -> None:
    validate_schema_value(value, schema, schema, "$descriptor")
    capabilities = value.get("capabilities", {})
    if value.get("format") != "ovdb-database/draft-1" or capabilities.get("read") is not True or capabilities.get("write") is not False or not isinstance(capabilities.get("query"), bool):
        raise GenerationError("generated OVDB descriptor has an invalid format or read-only capability shape")
    if not value.get("recordsets"):
        raise GenerationError("generated OVDB descriptor must expose at least one recordset")


def validate_schema_value(value: Any, schema: dict[str, Any], root_schema: dict[str, Any], path: str) -> None:
    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str) or not reference.startswith("#/"):
            raise GenerationError(f"unsupported public schema reference at {path}: {reference!r}")
        target: Any = root_schema
        for token in reference[2:].split("/"):
            target = target[token.replace("~1", "/").replace("~0", "~")]
        validate_schema_value(value, target, root_schema, path)
        return
    expected_type = schema.get("type")
    if expected_type is not None:
        types = expected_type if isinstance(expected_type, list) else [expected_type]
        type_checks = {
            "object": lambda item: isinstance(item, dict),
            "array": lambda item: isinstance(item, list),
            "string": lambda item: isinstance(item, str),
            "boolean": lambda item: isinstance(item, bool),
            "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
            "number": lambda item: isinstance(item, (int, float)) and not isinstance(item, bool),
            "null": lambda item: item is None,
        }
        if not any(type_checks[kind](value) for kind in types if kind in type_checks):
            raise GenerationError(f"public descriptor schema: {path} has the wrong type")
    if "const" in schema and value != schema["const"]:
        raise GenerationError(f"public descriptor schema: {path} must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise GenerationError(f"public descriptor schema: {path} is outside its allowed values")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise GenerationError(f"public descriptor schema: {path} is too short")
        pattern = schema.get("pattern")
        if pattern and not re.search(pattern, value):
            raise GenerationError(f"public descriptor schema: {path} does not match its required pattern")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value < schema.get("minimum", float("-inf")):
        raise GenerationError(f"public descriptor schema: {path} is below its minimum")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise GenerationError(f"public descriptor schema: {path} has too few items")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                validate_schema_value(item, item_schema, root_schema, f"{path}[{index}]")
    if isinstance(value, dict):
        missing = [key for key in schema.get("required", []) if key not in value]
        if missing:
            raise GenerationError(f"public descriptor schema: {path} misses {', '.join(missing)}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(properties))
            if extra:
                raise GenerationError(f"public descriptor schema: {path} has unknown fields {', '.join(extra)}")
        for key, item in value.items():
            if key in properties:
                validate_schema_value(item, properties[key], root_schema, f"{path}.{key}")


def generate(root: Path) -> None:
    root = root.resolve()
    manifest_path = safe_relative(root, "manifest.json", "manifest path")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not DATABASE_ID_PATTERN.fullmatch(str(manifest.get("id", ""))):
        raise GenerationError("manifest.id must be a lower-case database identifier")
    dbid = manifest["id"]
    config = manifest.get("generator")
    if not isinstance(config, dict):
        raise GenerationError("manifest.generator is required; see docs/provider-generator.md")
    source_path = safe_relative(root, manifest.get("dataFile"), "manifest.dataFile")
    if not source_path.is_file():
        raise GenerationError(f"source SQLite file does not exist: {source_path}")
    source_input_bytes = source_path.read_bytes()
    source_metadata = manifest.get("source")
    if not isinstance(source_metadata, dict):
        raise GenerationError("manifest.source must be an object that pins the SQLite fixture")
    input_compression = source_metadata.get("inputCompression")
    if input_compression is None:
        source_bytes = source_input_bytes
        input_digest = sha256(source_input_bytes)
        declared_input_digest = source_metadata.get("inputSha256")
        if declared_input_digest is not None and declared_input_digest != input_digest:
            raise GenerationError("manifest.source.inputSha256 differs from the pinned source file")
        database_path = source_path
        source_temp_directory = None
    elif input_compression == "gzip":
        declared_input_digest = source_metadata.get("inputSha256")
        if not isinstance(declared_input_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", declared_input_digest):
            raise GenerationError("manifest.source.inputSha256 must pin a gzip-compressed dataFile")
        input_digest = sha256(source_input_bytes)
        if input_digest != declared_input_digest:
            raise GenerationError(f"compressed source SHA-256 differs from manifest pin: expected {declared_input_digest}, got {input_digest}")
        try:
            source_bytes = gzip.decompress(source_input_bytes)
        except (OSError, EOFError, zlib.error) as error:
            raise GenerationError(f"manifest.dataFile is not a valid gzip source: {error}") from error
        source_temp_directory = None
        database_path = None
    else:
        raise GenerationError("manifest.source.inputCompression must be omitted or set to gzip")
    actual_digest = sha256(source_bytes)
    expected_digest = source_metadata.get("databaseSha256") or source_metadata.get("sha256")
    if not isinstance(expected_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise GenerationError("manifest.source must pin the SQLite fixture using databaseSha256 or sha256")
    if actual_digest != expected_digest:
        raise GenerationError(f"source SQLite SHA-256 differs from manifest pin: expected {expected_digest}, got {actual_digest}")
    if not all(isinstance(manifest.get(key), str) and manifest[key] for key in ("name", "description", "siteHost")):
        raise GenerationError("manifest.name, description, and siteHost are required")
    if manifest.get("siteHost") != f"{dbid}.demodb.dev":
        raise GenerationError("manifest.siteHost must match <id>.demodb.dev")

    shared_schema_path = Path(__file__).resolve().parents[2] / "schemas" / DATABASE_SCHEMA_NAME
    shared_schema = shared_schema_path.read_bytes()
    if sha256(shared_schema) != DATABASE_SCHEMA_SHA256:
        raise GenerationError(f"shared OVDB schema pin changed: {sha256(shared_schema)}")
    schema_copy_path = root / "schemas" / DATABASE_SCHEMA_NAME
    if schema_copy_path.exists() and schema_copy_path.read_bytes() != shared_schema:
        raise GenerationError(f"{schema_copy_path.relative_to(root)} differs from the shared schema pin")

    if input_compression == "gzip":
        source_temp_directory = tempfile.TemporaryDirectory(prefix="demodb-source-")
        database_path = Path(source_temp_directory.name) / "source.sqlite"
        database_path.write_bytes(source_bytes)
    try:
        connection = sqlite3.connect(f"file:{quote(database_path.as_posix(), safe='/')}?mode=ro", uri=True)
    except Exception:
        if source_temp_directory is not None:
            source_temp_directory.cleanup()
        raise
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    outputs: dict[str, bytes] = {}
    exports: list[dict[str, Any]] = []
    try:
        verify_sqlite_source(connection)
        objects = connection.execute("SELECT type,name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name COLLATE BINARY").fetchall()
        if not objects:
            raise GenerationError("source fixture has no tables or views")
        all_names = [item["name"] for item in objects]
        if len(set(all_names)) != len(all_names):
            raise GenerationError("source fixture contains duplicate recordset names")
        descriptions = manifest.get("tableDescriptions", {})
        if not isinstance(descriptions, dict):
            raise GenerationError("manifest.tableDescriptions must be an object")
        column_descriptions = manifest.get("columnDescriptions", {})
        if not isinstance(column_descriptions, dict):
            raise GenerationError("manifest.columnDescriptions must map native table names to column-description objects")
        schema_tables = [recordset_info(connection, item["name"], item["type"], descriptions.get(item["name"], "")) for item in objects]
        unknown_table_descriptions = set(descriptions) - {item["name"] for item in schema_tables}
        if unknown_table_descriptions:
            raise GenerationError(f"tableDescriptions references unknown native recordsets: {', '.join(sorted(unknown_table_descriptions))}")
        for name, description in descriptions.items():
            if not isinstance(description, str):
                raise GenerationError(f"table description for {name!r} must be a string")
        schema_table_names = {item["name"] for item in schema_tables if item["kind"] == "table"}
        unknown_descriptions = set(column_descriptions) - schema_table_names
        if unknown_descriptions:
            raise GenerationError(f"columnDescriptions references unknown native tables: {', '.join(sorted(unknown_descriptions))}")
        for table in schema_tables:
            table_notes = column_descriptions.get(table["name"], {})
            if not isinstance(table_notes, dict):
                raise GenerationError(f"columnDescriptions for {table['name']!r} must be an object")
            known_columns = {column["name"] for column in table["columns"]}
            unknown_columns = set(table_notes) - known_columns
            if unknown_columns:
                raise GenerationError(f"columnDescriptions for {table['name']!r} reference unknown columns: {', '.join(sorted(unknown_columns))}")
            for column in table["columns"]:
                if column["name"] in table_notes:
                    description = table_notes[column["name"]]
                    if not isinstance(description, str) or not description:
                        raise GenerationError(f"column description for {table['name']}.{column['name']} must be a non-empty string")
                    column["description"] = description
        source_views, native_objects_input = native_source_views(root, config, schema_tables)
        model, model_json, model_hcl, meaning_json = model_files(dbid, config, schema_tables)
        aliases = config.get("modelEntityAliases", {})
        modeling_limitations = []
        for item in schema_tables:
            if item["kind"] == "table":
                entity_name = aliases.get(item["name"], re.sub(r"[^A-Za-z0-9_]", "_", item["name"]))
                item["modelEntity"] = entity_name
                item["modelRecordset"] = None
        schema = {
            "contractVersion": manifest.get("contractVersion", 1),
            "database": {"id": dbid, "name": manifest["name"]},
            "source": manifest["source"],
            "blobEncoding": "base64",
            "modelingLimitations": modeling_limitations,
            "tables": schema_tables,
            "sourceViews": source_views,
        }
        outputs[f"model/{dbid}.modelspec.json"] = model_json
        outputs[f"model/{dbid}.modelspec.hcl"] = model_hcl
        outputs[f"model/{dbid}.meaning.yaml"] = meaning_json
        outputs[f"metadata/schema.json"] = canonical_json(schema)

        for item in schema_tables:
            if item["kind"] != "table":
                continue
            name = item["name"]
            if "/" in name or "\\" in name or name in (".", "..") or "\x00" in name:
                raise GenerationError(f"native recordset name cannot be represented by the website asset routes: {name!r}")
            for extension, builder in (("json", dump_json), ("csv", dump_csv)):
                relative = f"artifacts/data/{name}.{extension}"
                export_path = safe_relative(root, relative, "generated export path")
                contents = builder(connection, name, export_path)
                outputs[relative] = contents
                exports.append({"table": name, "format": extension, "path": relative, "bytes": len(contents)})
        sqlite_relative = f"artifacts/{dbid}.sqlite"
        sql_relative = f"artifacts/{dbid}.sql"
        outputs[sqlite_relative] = source_bytes
        sql_bytes = dump_sql(connection, root / sql_relative)
        outputs[sql_relative] = sql_bytes
        exports.insert(0, {"table": None, "format": "sql", "path": sql_relative, "bytes": len(sql_bytes)})
        exports.insert(0, {"table": None, "format": "sqlite", "path": sqlite_relative, "bytes": len(source_bytes)})
        compress_large_exports(outputs, exports)

        contract = {
            "contractVersion": manifest.get("contractVersion", 1),
            "manifest": manifest,
            "schema": schema,
            "exports": exports,
        }
        outputs["metadata/contract.json"] = canonical_json(contract)
        schema_copy = {"sha256": sha256(shared_schema), "bytes": len(shared_schema)}
        outputs[f"schemas/{DATABASE_SCHEMA_NAME}"] = shared_schema
        outputs["ovdb.yaml"], outputs["ovdb-database.json"] = ovdb_files(root, manifest, config, schema, actual_digest, shared_schema, model)
        checksum_paths = dict(outputs)
        checksum_paths["manifest.json"] = manifest_path.read_bytes()
        if native_objects_input is not None:
            input_path, input_bytes = native_objects_input
            if input_path in checksum_paths:
                raise GenerationError(f"generator.nativeObjectsFile conflicts with generated output path {input_path!r}")
            checksum_paths[input_path] = input_bytes
        checksums = {
            "contractVersion": 1,
            "files": {path: {"sha256": sha256(contents), "bytes": len(contents)} for path, contents in sorted(checksum_paths.items())},
        }
        for export in exports:
            if export.get("compression") != "gzip" or export.get("chunks"):
                continue
            checksums["files"][export["encodedPath"]].update({
                key: export[key] for key in ("compression", "decodedBytes", "decodedSha256")
            })
        checksums["files"][f"schemas/{DATABASE_SCHEMA_NAME}"] = schema_copy
        outputs["metadata/checksums.json"] = canonical_json(checksums)
        for relative, contents in outputs.items():
            if len(contents) > MAX_STATIC_EXPORT_BYTES:
                raise GenerationError(f"generated file {relative!r} exceeds the {MAX_STATIC_EXPORT_BYTES}-byte static export limit; preserve the full source data and use compressed or paged delivery")

        old_checksums_path = root / "metadata" / "checksums.json"
        old_generated: set[str] = set()
        old_input_paths = {native_objects_input[0]} if native_objects_input is not None else set()
        old_contract_path = root / "metadata" / "contract.json"
        if old_contract_path.is_file():
            try:
                old_contract = json.loads(old_contract_path.read_text(encoding="utf-8"))
                old_native_path = old_contract.get("manifest", {}).get("generator", {}).get("nativeObjectsFile")
                if isinstance(old_native_path, str):
                    old_input_paths.add(old_native_path)
            except (json.JSONDecodeError, AttributeError, TypeError):
                pass
        if old_checksums_path.is_file():
            try:
                previous = json.loads(old_checksums_path.read_text(encoding="utf-8"))
                old_generated = set(previous.get("files", {})) - {"manifest.json"} - old_input_paths
            except (json.JSONDecodeError, AttributeError, TypeError):
                old_generated = set()

        # Stage the complete generation first, so bad inputs never erase the
        # last valid artifact set. Replace files only after all checks pass.
        stage_root = Path(tempfile.mkdtemp(prefix=".provider-generator-", dir=root))
        try:
            for relative, contents in sorted(outputs.items()):
                staged = safe_relative(stage_root, relative, "staged output path")
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes(contents)
            for relative in sorted(outputs):
                staged = safe_relative(stage_root, relative, "staged output path")
                target = safe_relative(root, relative, "generated output path")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, target)
            for relative in sorted(old_generated - set(outputs)):
                stale = safe_relative(root, relative, "stale generated output path")
                if stale.is_file():
                    stale.unlink()
        finally:
            shutil.rmtree(stage_root, ignore_errors=True)
    finally:
        connection.close()
        if source_temp_directory is not None:
            source_temp_directory.cleanup()
    print(f"Generated {len(schema_tables)} native tables/views and {len(exports)} exports for {dbid}; source sha256 {actual_digest}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="provider repository root containing manifest.json")
    args = parser.parse_args(argv)
    try:
        generate(args.root)
    except (GenerationError, OSError, sqlite3.Error, json.JSONDecodeError) as error:
        print(f"provider generator: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
