"""Fault-injection tests for the fail-closed container image scan validator."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate-container-image-scan.py")
WORKFLOW = SCRIPT.parents[1] / ".github" / "workflows" / "deploy.yml"
IMAGE_ID = "sha256:" + "a" * 64
SCANNER_SHA256 = "b" * 64
VULNERABILITY_FINDING_FIELDS = (
    "VulnerabilityID",
    "PkgID",
    "PkgName",
    "PkgPath",
    "InstalledVersion",
    "FixedVersion",
    "Severity",
    "Status",
)


def rfc3339(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def rfc3339_fraction(value: datetime, fraction: str) -> str:
    if not 1 <= len(fraction) <= 9 or not fraction.isascii() or not fraction.isdigit():
        raise ValueError("fraction must contain 1-9 ASCII digits")
    return f'{value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")}.{fraction}Z'


def finding_fingerprint_sha256(result: dict, vulnerability: dict) -> str:
    projection = {
        "Class": result["Class"],
        "Type": result["Type"],
        "Target": result["Target"],
        **{
            field: vulnerability.get(field)
            for field in VULNERABILITY_FINDING_FIELDS
        },
    }
    payload = json.dumps(
        projection,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class ContainerImageScanValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        self.started = now - timedelta(minutes=2)
        self.completed = now - timedelta(seconds=20)
        self.updated = now - timedelta(hours=1)
        self.downloaded = now - timedelta(minutes=1)
        self.next_update = now + timedelta(hours=5)
        self.report_path = self.root / "report.json"
        self.metadata_path = self.root / "metadata.json"
        self.database_path = self.root / "trivy.db"
        self.receipt_path = self.root / "receipt.json"
        self.write_report(self.valid_report())
        self.write_metadata(self.valid_metadata())
        self.database_path.write_bytes(b"sqlite-db-fixture\x00" * 32)

    def valid_report(self) -> dict:
        return {
            "SchemaVersion": 2,
            "ArtifactName": "diva-player-api:current",
            "ArtifactType": "container_image",
            "Metadata": {
                "ImageID": IMAGE_ID,
                "ImageConfig": {
                    "architecture": "amd64",
                    "os": "linux",
                },
                "OS": {
                    "Family": "alpine",
                    "Name": "3.24",
                },
            },
            "Results": [
                {
                    "Target": "Alpine Linux v3.24",
                    "Class": "os-pkgs",
                    "Type": "alpine",
                    "Packages": [
                        {"Name": "musl", "Version": "1.2.5-r23"},
                        {"Name": "busybox", "Version": "1.37.0-r30"},
                    ],
                    "Vulnerabilities": None,
                },
                {
                    "Target": "VocadbRecommender.deps.json",
                    "Class": "lang-pkgs",
                    "Type": "dotnet-core",
                    "Packages": [
                        {"Name": f"Runtime.Package.{index}", "Version": "8.0.0"}
                        for index in range(11)
                    ],
                    "Vulnerabilities": [],
                },
                {
                    "Target": "VocadbRecommender.dll",
                    "Class": "lang-pkgs",
                    "Type": "nuget",
                    "Packages": [
                        {"Name": f"NuGet.Package.{index}", "Version": "8.0.0"}
                        for index in range(12)
                    ],
                    "Vulnerabilities": [],
                },
                {
                    "Target": "VocadbRecommender.dll",
                    "Class": "lang-pkgs",
                    "Type": "dotnet-core",
                    "Packages": [{"Name": "Npgsql", "Version": "8.0.3"}],
                    "Vulnerabilities": [],
                },
                {
                    "Target": "VocadbRecommender.runtimeconfig.json",
                    "Class": "lang-pkgs",
                    "Type": "dotnet-core",
                    "Packages": [
                        {"Name": "Qdrant.Client", "Version": "1.19.0"}
                    ],
                    "Vulnerabilities": [],
                },
            ],
        }

    def valid_metadata(self) -> dict:
        return {
            "Version": 2,
            "UpdatedAt": rfc3339(self.updated),
            "DownloadedAt": rfc3339(self.downloaded),
            "NextUpdate": rfc3339(self.next_update),
        }

    def exact_finding(self) -> dict:
        return {
            "VulnerabilityID": "CVE-2026-12345",
            "PkgID": "busybox@1.37.0-r30",
            "PkgName": "busybox",
            "PkgPath": "/lib/apk/db/installed",
            "InstalledVersion": "1.37.0-r30",
            "FixedVersion": "1.37.0-r31",
            "Severity": "HIGH",
            "Status": "fixed",
        }

    def write_report(self, document: dict) -> None:
        self.report_path.write_text(json.dumps(document), encoding="utf-8")

    def write_metadata(self, document: dict) -> None:
        self.metadata_path.write_text(json.dumps(document), encoding="utf-8")

    def validation_arguments(
        self,
        *,
        receipt: Path | None = None,
        service: str = "api",
        allowed_findings: tuple[str, ...] = (),
    ) -> list[str]:
        arguments = [
            "validate",
            "--service",
            service,
            "--expected-image-id",
            IMAGE_ID,
            "--expected-architecture",
            "amd64",
            "--expected-os",
            "linux",
            "--expected-os-family",
            "alpine",
            "--report",
            str(self.report_path),
            "--db-metadata",
            str(self.metadata_path),
            "--db",
            str(self.database_path),
            "--receipt",
            str(receipt or self.receipt_path),
            "--inventory-bound",
            "os-pkgs:alpine:2:16:1",
            "--inventory-bound",
            "lang-pkgs:dotnet-core:13:16:3",
            "--inventory-bound",
            "lang-pkgs:nuget:12:12:1",
            "--scanner-version",
            "0.74.0",
            "--scanner-sha256",
            SCANNER_SHA256,
            "--scan-started-at",
            rfc3339(self.started),
            "--scan-completed-at",
            rfc3339(self.completed),
        ]
        for fingerprint in allowed_findings:
            arguments.extend(("--allowed-finding-sha256", fingerprint))
        return arguments

    def verification_arguments(
        self,
        receipt_sha256: str,
        *,
        expected_image_id: str = IMAGE_ID,
        service: str = "api",
    ) -> list[str]:
        return [
            "verify",
            "--service",
            service,
            "--expected-image-id",
            expected_image_id,
            "--expected-architecture",
            "amd64",
            "--expected-os",
            "linux",
            "--expected-os-family",
            "alpine",
            "--report",
            str(self.report_path),
            "--db-metadata",
            str(self.metadata_path),
            "--db",
            str(self.database_path),
            "--receipt",
            str(self.receipt_path),
            "--expected-receipt-sha256",
            receipt_sha256,
        ]

    def run_validator(self, arguments: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *arguments],
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )

    def validate_successfully(self) -> dict:
        result = self.run_validator(self.validation_arguments())
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["imageId"], IMAGE_ID)
        self.assertEqual(summary["architecture"], "amd64")
        self.assertRegex(summary["receiptSha256"], r"^[0-9a-f]{64}$")
        return summary

    def assert_validation_fails(self, *, receipt: Path | None = None) -> None:
        result = self.run_validator(self.validation_arguments(receipt=receipt))
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("ERROR:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_validate_and_verify_exact_artifacts(self) -> None:
        summary = self.validate_successfully()
        verify = self.run_validator(
            self.verification_arguments(summary["receiptSha256"])
        )
        self.assertEqual(verify.returncode, 0, verify.stderr)
        verified = json.loads(verify.stdout)
        self.assertEqual(verified["receiptSha256"], summary["receiptSha256"])
        self.assertEqual(verified["reportSha256"], summary["reportSha256"])
        self.assertEqual(verified["databaseSha256"], summary["databaseSha256"])
        self.assertEqual(verified["packageCount"], 27)
        if os.name == "posix":
            self.assertEqual(self.receipt_path.stat().st_mode & 0o777, 0o600)

    def test_exact_rollback_finding_succeeds_validate_and_verify(self) -> None:
        report = self.valid_report()
        result = report["Results"][0]
        finding = self.exact_finding()
        result["Vulnerabilities"] = [finding]
        fingerprint = finding_fingerprint_sha256(result, finding)
        self.write_report(report)

        validation = self.run_validator(
            self.validation_arguments(
                service="qdrant-rollback",
                allowed_findings=(fingerprint,),
            )
        )
        self.assertEqual(validation.returncode, 0, validation.stderr)
        summary = json.loads(validation.stdout)
        self.assertEqual(summary["highCriticalCount"], 1)

        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(receipt["schemaVersion"], 2)
        self.assertEqual(
            receipt["findings"],
            [{"count": 1, "sha256": fingerprint}],
        )
        self.assertEqual(receipt["verdict"]["highCriticalCount"], 1)

        verification = self.run_validator(
            self.verification_arguments(
                summary["receiptSha256"],
                service="qdrant-rollback",
            )
        )
        self.assertEqual(verification.returncode, 0, verification.stderr)
        self.assertEqual(json.loads(verification.stdout)["highCriticalCount"], 1)

    def test_repeated_allowlist_flags_bind_duplicate_multiplicity(self) -> None:
        report = self.valid_report()
        result = report["Results"][0]
        finding = self.exact_finding()
        result["Vulnerabilities"] = [finding, dict(finding)]
        fingerprint = finding_fingerprint_sha256(result, finding)
        self.write_report(report)

        validation = self.run_validator(
            self.validation_arguments(
                service="postgres-rollback",
                allowed_findings=(fingerprint, fingerprint),
            )
        )
        self.assertEqual(validation.returncode, 0, validation.stderr)
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(
            receipt["findings"],
            [{"count": 2, "sha256": fingerprint}],
        )
        self.assertEqual(receipt["verdict"]["highCriticalCount"], 2)

    def test_rollback_allowlist_rejects_extra_missing_drift_and_multiplicity(self) -> None:
        baseline_report = self.valid_report()
        baseline_result = baseline_report["Results"][0]
        baseline_finding = self.exact_finding()
        fingerprint = finding_fingerprint_sha256(
            baseline_result,
            baseline_finding,
        )

        cases: list[tuple[str, list[dict]]] = []
        extra = [dict(baseline_finding), dict(baseline_finding)]
        extra[1]["VulnerabilityID"] = "CVE-2026-99999"
        cases.append(("extra", extra))
        cases.append(("missing", []))
        drifted = dict(baseline_finding)
        drifted["FixedVersion"] = "1.37.0-r32"
        cases.append(("field-drift", [drifted]))
        cases.append(
            ("duplicate-multiplicity", [dict(baseline_finding), dict(baseline_finding)])
        )

        for index, (label, findings) in enumerate(cases):
            with self.subTest(label=label):
                report = self.valid_report()
                report["Results"][0]["Vulnerabilities"] = findings
                self.write_report(report)
                receipt_path = self.root / f"finding-mismatch-{index}.json"
                validation = self.run_validator(
                    self.validation_arguments(
                        receipt=receipt_path,
                        service="qdrant-rollback",
                        allowed_findings=(fingerprint,),
                    )
                )
                self.assertNotEqual(validation.returncode, 0, validation.stdout)
                self.assertIn("fingerprint multiset", validation.stderr)
                self.assertFalse(receipt_path.exists())

    def test_nonrollback_allowlist_and_default_candidate_finding_are_rejected(self) -> None:
        report = self.valid_report()
        result = report["Results"][0]
        finding = self.exact_finding()
        result["Vulnerabilities"] = [finding]
        fingerprint = finding_fingerprint_sha256(result, finding)
        self.write_report(report)

        nonrollback_receipt = self.root / "nonrollback.json"
        nonrollback = self.run_validator(
            self.validation_arguments(
                receipt=nonrollback_receipt,
                service="api",
                allowed_findings=(fingerprint,),
            )
        )
        self.assertNotEqual(nonrollback.returncode, 0, nonrollback.stdout)
        self.assertIn("only for exact rollback images", nonrollback.stderr)
        self.assertFalse(nonrollback_receipt.exists())

        candidate_receipt = self.root / "candidate.json"
        candidate = self.run_validator(
            self.validation_arguments(receipt=candidate_receipt, service="api")
        )
        self.assertNotEqual(candidate.returncode, 0, candidate.stdout)
        self.assertIn("fingerprint multiset", candidate.stderr)
        self.assertFalse(candidate_receipt.exists())

    def test_verify_revalidates_receipt_finding_multiset(self) -> None:
        report = self.valid_report()
        result = report["Results"][0]
        finding = self.exact_finding()
        result["Vulnerabilities"] = [finding]
        fingerprint = finding_fingerprint_sha256(result, finding)
        self.write_report(report)
        validation = self.run_validator(
            self.validation_arguments(
                service="qdrant-rollback",
                allowed_findings=(fingerprint,),
            )
        )
        self.assertEqual(validation.returncode, 0, validation.stderr)

        report["Results"][0]["Vulnerabilities"][0]["Status"] = "affected"
        self.write_report(report)
        report_payload = self.report_path.read_bytes()
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        receipt["scan"]["reportSha256"] = hashlib.sha256(report_payload).hexdigest()
        receipt["scan"]["reportSize"] = len(report_payload)
        receipt_payload = (
            json.dumps(
                receipt,
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        self.receipt_path.write_bytes(receipt_payload)
        receipt_sha256 = hashlib.sha256(receipt_payload).hexdigest()

        verification = self.run_validator(
            self.verification_arguments(
                receipt_sha256,
                service="qdrant-rollback",
            )
        )
        self.assertNotEqual(verification.returncode, 0, verification.stdout)
        self.assertIn("fingerprint multiset", verification.stderr)

    def test_report_identity_contract_is_exact(self) -> None:
        mutations = {
            "schema": lambda value: value.__setitem__("SchemaVersion", 1),
            "artifact-type": lambda value: value.__setitem__("ArtifactType", "filesystem"),
            "image-id": lambda value: value["Metadata"].__setitem__(
                "ImageID", "sha256:" + "c" * 64
            ),
            "architecture": lambda value: value["Metadata"]["ImageConfig"].__setitem__(
                "architecture", "arm64"
            ),
            "container-os": lambda value: value["Metadata"]["ImageConfig"].__setitem__(
                "os", "windows"
            ),
            "os-family": lambda value: value["Metadata"]["OS"].__setitem__(
                "Family", "debian"
            ),
            "unhashable-result-class": lambda value: value["Results"][0].__setitem__(
                "Class", []
            ),
        }
        for index, (label, mutate) in enumerate(mutations.items()):
            with self.subTest(label=label):
                report = self.valid_report()
                mutate(report)
                self.write_report(report)
                self.assert_validation_fails(receipt=self.root / f"receipt-{index}.json")

    def test_vulnerability_and_inventory_gaps_fail_closed(self) -> None:
        reports = []
        vulnerability = self.valid_report()
        vulnerability["Results"][0]["Vulnerabilities"] = [
            {"VulnerabilityID": "CVE-TEST", "Severity": "HIGH"}
        ]
        reports.append(("vulnerability", vulnerability))
        empty_os = self.valid_report()
        empty_os["Results"][0]["Packages"] = []
        reports.append(("empty-os-inventory", empty_os))
        missing_language = self.valid_report()
        missing_language["Results"] = missing_language["Results"][:1]
        reports.append(("missing-language-inventory", missing_language))
        missing_os = self.valid_report()
        missing_os["Results"].pop(0)
        reports.append(("missing-os-inventory", missing_os))
        partial_language = self.valid_report()
        partial_language["Results"][1]["Packages"].pop()
        reports.append(("one-package-partial-inventory", partial_language))
        oversized_language = self.valid_report()
        oversized_language["Results"][1]["Packages"] = [
            {"Name": f"Package{index}", "Version": "1.0.0"}
            for index in range(17)
        ]
        reports.append(("inventory-package-creep", oversized_language))
        empty_result = self.valid_report()
        empty_result["Results"][1]["Packages"].append(
            empty_result["Results"][3]["Packages"][0]
        )
        empty_result["Results"][3]["Packages"] = []
        reports.append(("empty-individual-result", empty_result))
        duplicate = self.valid_report()
        duplicate["Results"].append(dict(duplicate["Results"][1]))
        reports.append(("duplicate-required-inventory", duplicate))
        unknown = self.valid_report()
        unknown["Results"].append(
            {
                "Target": "unknown",
                "Class": "secret",
                "Type": "unknown",
                "Packages": [{"Name": "unknown", "Version": "1"}],
                "Vulnerabilities": [],
            }
        )
        reports.append(("unknown-result-key", unknown))
        malformed_package = self.valid_report()
        malformed_package["Results"][1]["Packages"][0].pop("Version")
        reports.append(("missing-package-version", malformed_package))
        for index, (label, report) in enumerate(reports):
            with self.subTest(label=label):
                self.write_report(report)
                self.assert_validation_fails(receipt=self.root / f"inventory-{index}.json")

    def test_unreviewed_result_key_is_named_but_still_rejected(self) -> None:
        report = self.valid_report()
        report["Results"].append(
            {
                "Target": "unexpected",
                "Class": "secret",
                "Type": "unknown",
                "Packages": [{"Name": "unexpected", "Version": "1"}],
                "Vulnerabilities": None,
            }
        )
        self.write_report(report)
        result = self.run_validator(self.validation_arguments())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("secret:unknown", result.stderr)
        self.assertFalse(self.receipt_path.exists())

    def test_database_freshness_contract_is_exact(self) -> None:
        metadata_documents = []
        wrong_version = self.valid_metadata()
        wrong_version["Version"] = 1
        metadata_documents.append(("version", wrong_version))
        old_download = self.valid_metadata()
        old_download["DownloadedAt"] = rfc3339(self.started - timedelta(hours=1))
        metadata_documents.append(("run-download", old_download))
        stale = self.valid_metadata()
        stale["UpdatedAt"] = rfc3339(self.completed - timedelta(days=2))
        metadata_documents.append(("freshness", stale))
        backwards = self.valid_metadata()
        backwards["NextUpdate"] = rfc3339(self.updated)
        metadata_documents.append(("next-update", backwards))
        for index, (label, document) in enumerate(metadata_documents):
            with self.subTest(label=label):
                self.write_report(self.valid_report())
                self.write_metadata(document)
                self.assert_validation_fails(receipt=self.root / f"db-{index}.json")

    def test_go_rfc3339_nanoseconds_are_retained_exactly(self) -> None:
        metadata = self.valid_metadata()
        metadata["UpdatedAt"] = rfc3339_fraction(self.updated, "78069098")
        metadata["DownloadedAt"] = rfc3339_fraction(self.downloaded, "434935021")
        metadata["NextUpdate"] = rfc3339_fraction(self.next_update, "780690593")
        self.write_metadata(metadata)
        result = self.run_validator(self.validation_arguments())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(receipt["database"]["updatedAt"], metadata["UpdatedAt"])
        self.assertEqual(receipt["database"]["downloadedAt"], metadata["DownloadedAt"])
        self.assertEqual(receipt["database"]["nextUpdate"], metadata["NextUpdate"])

    def test_noncanonical_or_overprecision_rfc3339_fails_closed(self) -> None:
        invalid_values = (
            "2026-08-31T13:59:52.1234567890Z",
            "2026-08-31T13:59:52.1z",
            "2026-08-31 13:59:52.1Z",
            "2026-08-31T13:59:52,1Z",
            "2026-08-31T13:59:52-00:00",
        )
        for index, invalid in enumerate(invalid_values):
            with self.subTest(value=invalid):
                metadata = self.valid_metadata()
                metadata["UpdatedAt"] = invalid
                self.write_metadata(metadata)
                self.assert_validation_fails(
                    receipt=self.root / f"invalid-rfc3339-{index}.json"
                )

    def test_truncated_duplicate_and_oversized_reports_fail_closed(self) -> None:
        invalid_documents = [
            b'{"SchemaVersion":2,',
            b'{"SchemaVersion":2,"SchemaVersion":2}',
            b"\xff\xfe",
        ]
        for index, payload in enumerate(invalid_documents):
            with self.subTest(index=index):
                self.report_path.write_bytes(payload)
                self.assert_validation_fails(receipt=self.root / f"json-{index}.json")
        self.report_path.write_bytes(b"x")
        with self.report_path.open("r+b") as oversized:
            oversized.truncate(128 * 1024 * 1024 + 1)
        self.assert_validation_fails(receipt=self.root / "oversized.json")

    def test_hardlink_and_symlink_inputs_fail_closed(self) -> None:
        original = self.root / "original-report.json"
        shutil.copyfile(self.report_path, original)
        hardlink = self.root / "hardlink-report.json"
        os.link(original, hardlink)
        self.report_path = hardlink
        self.assert_validation_fails(receipt=self.root / "hardlink-receipt.json")

        self.report_path = self.root / "symlink-report.json"
        try:
            os.symlink(original, self.report_path)
        except (OSError, NotImplementedError):
            return
        self.assert_validation_fails(receipt=self.root / "symlink-receipt.json")

    def test_receipt_is_exclusive_and_never_overwritten(self) -> None:
        self.receipt_path.write_text("preexisting evidence", encoding="utf-8")
        self.assert_validation_fails()
        self.assertEqual(
            self.receipt_path.read_text(encoding="utf-8"),
            "preexisting evidence",
        )

    def test_freshness_policy_cannot_be_weakened_past_ceiling(self) -> None:
        arguments = [
            *self.validation_arguments(),
            "--maximum-db-age-seconds",
            "86401",
        ]
        result = self.run_validator(arguments)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("policy ceiling", result.stderr)

    def test_report_tamper_after_attestation_is_rejected(self) -> None:
        summary = self.validate_successfully()
        report = self.valid_report()
        report["ArtifactName"] = "tampered"
        self.write_report(report)
        result = self.run_validator(
            self.verification_arguments(summary["receiptSha256"])
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ERROR:", result.stderr)

    def test_database_and_metadata_tamper_after_attestation_are_rejected(self) -> None:
        summary = self.validate_successfully()
        with self.database_path.open("ab") as database:
            database.write(b"tamper")
        result = self.run_validator(
            self.verification_arguments(summary["receiptSha256"])
        )
        self.assertNotEqual(result.returncode, 0)

        self.database_path.write_bytes(b"sqlite-db-fixture\x00" * 32)
        metadata = self.valid_metadata()
        metadata["DownloadedAt"] = rfc3339(self.downloaded + timedelta(seconds=1))
        self.write_metadata(metadata)
        result = self.run_validator(
            self.verification_arguments(summary["receiptSha256"])
        )
        self.assertNotEqual(result.returncode, 0)

    def test_receipt_tamper_and_wrong_expected_image_are_rejected(self) -> None:
        summary = self.validate_successfully()
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        receipt["service"] = "tampered"
        self.receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        result = self.run_validator(
            self.verification_arguments(summary["receiptSha256"])
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("trusted journal", result.stderr)

        self.receipt_path.unlink()
        summary = self.validate_successfully()
        result = self.run_validator(
            self.verification_arguments(
                summary["receiptSha256"],
                expected_image_id="sha256:" + "c" * 64,
            )
        )
        self.assertNotEqual(result.returncode, 0)


class DeployImageScanWorkflowContractTests(unittest.TestCase):
    def setUp(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        start = workflow.index("      - name: Attest exact deployable image vulnerability scans")
        end = workflow.index("      - name: Start preview server for E2E", start)
        self.workflow = workflow
        self.gate = workflow[start:end]

    def test_all_deployable_images_are_exact_id_scanned(self) -> None:
        expected_records = [
            "api|diva-player-ci-api:current|alpine|",
            "gateway|diva-player-ci-gateway:current|alpine|",
            "web|diva-player-ci-web:current|alpine|",
            "qdrant-runtime|diva-player-ci-qdrant:current|debian|",
            "qdrant-audit-tool|diva-player-ci-qdrant-audit:current|alpine|",
            "pgvector-runtime|diva-player-ci-postgres:current|alpine|",
            "postgres-migrate-helper|diva-player-ci-postgres-migrate:current|alpine|",
        ]
        for record in expected_records:
            with self.subTest(record=record):
                self.assertIn(record, self.gate)
        self.assertNotIn('docker pull "$source_reference"', self.gate)
        self.assertNotIn("pull_first", self.gate)
        self.assertIn("docker image inspect --format '{{.Id}}' \"$source_reference\"", self.gate)
        self.assertIn("docker image inspect --format '{{.Id}}' \"$image_id\"", self.gate)
        self.assertIn('"$scanner" image', self.gate)
        self.assertIn('"$image_id" || scan_status=$?', self.gate)
        self.assertNotIn('"$scanner" image "$source_reference"', self.gate)
        self.assertGreaterEqual(
            self.gate.count("source reference moved"),
            2,
            "the source reference must be rebound both after scanning and before gate completion",
        )

    def test_scan_cannot_consume_repository_or_user_ignore_configuration(self) -> None:
        exact_scan_invocation = """            env -i \\
              HOME="$scanner_home" \\
              PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
              "$scanner" image \\
              --config "$empty_config" \\
              --ignorefile "$empty_ignore" \\
              --cache-dir "$cache_dir" \\
              --image-src docker \\
              --scanners vuln \\
              --severity HIGH,CRITICAL \\
              --format json \\
              --list-all-pkgs \\
              --output "$report" \\
              --exit-code 1 \\
              --timeout 30m \\
              "$image_id" || scan_status=$?"""
        self.assertEqual(self.gate.count("env -i \\"), 1)
        self.assertEqual(self.gate.count('"$scanner" image \\'), 1)
        self.assertIn(exact_scan_invocation, self.gate)
        for contract in (
            "set -euo pipefail",
            "umask 077",
            'test ! -e "$evidence_root"',
            'install -d -m 0700 "$evidence_root" "$cache_dir" "$scanner_home"',
            'install -m 0600 /dev/null "$empty_config"',
            'install -m 0600 /dev/null "$empty_ignore"',
            "env -i \\",
            'HOME="$scanner_home"',
            '--config "$empty_config"',
            '--ignorefile "$empty_ignore"',
            '--cache-dir "$cache_dir"',
            "--image-src docker",
            "--scanners vuln",
            "--severity HIGH,CRITICAL",
            "--format json",
            "--list-all-pkgs",
            "--exit-code 1",
            "--timeout 30m",
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, self.gate)
        self.assertNotIn("command -v jq", self.gate)
        self.assertNotIn(".trivyignore", self.gate)

    def test_reviewed_inventory_and_receipt_contracts_are_fail_closed(self) -> None:
        expected_bounds = (
            "os-pkgs:alpine:21:21:1",
            "lang-pkgs:dotnet-core:13:13:3",
            "lang-pkgs:nuget:12:12:1",
            "os-pkgs:alpine:24:24:1",
            "os-pkgs:alpine:70:70:1",
            "os-pkgs:debian:8:8:1",
            "os-pkgs:alpine:3:3:1",
            "os-pkgs:alpine:46:46:1",
            "os-pkgs:alpine:24:24:1",
        )
        for bound in expected_bounds:
            with self.subTest(bound=bound):
                self.assertIn(bound, self.gate)
        for contract in (
            "scripts/validate-container-image-scan.py validate",
            "scripts/validate-container-image-scan.py verify",
            '--expected-image-id "$image_id"',
            '--expected-receipt-sha256 "$receipt_sha256"',
            'sha256sum "$receipt"',
            '"receiptSha256"',
            '"busybox-binsh=1.37.0-r30"',
            '"busybox=1.37.0-r30"',
            '"musl=1.2.5-r23"',
            'exit "$overall_failure"',
        ):
            with self.subTest(contract=contract):
                self.assertIn(contract, self.gate)

    def test_scanner_and_local_postgres_sources_are_immutable(self) -> None:
        self.assertIn(
            "TRIVY_ARCHIVE_SHA256: 2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
            self.workflow,
        )
        self.assertIn(
            "TRIVY_BINARY_SHA256: d89bcc6510a267f11b773398cbf1be5520ce39f9e8b6633178c4487f05b7d791",
            self.workflow,
        )
        for old_digest in (
            "ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b",
            "cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
        ):
            self.assertNotIn(old_digest, self.workflow)
        self.assertIn(
            "--file backend/database/Dockerfile.pgvector", self.workflow
        )
        self.assertIn(
            "--tag diva-player-ci-postgres:current backend/database", self.workflow
        )
        self.assertIn(
            "--file backend/database/Dockerfile.migrate", self.workflow
        )
        self.assertIn(
            "--tag diva-player-ci-postgres-migrate:current backend/database",
            self.workflow,
        )
        self.assertNotRegex(self.workflow, r"(?m)^    services:\s*$")


if __name__ == "__main__":
    unittest.main(verbosity=2)
