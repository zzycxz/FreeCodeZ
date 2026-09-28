// B2 门禁:帧完整性合同(image-ref 凭据/raster envelope/成对保留/200KB 内联上限)。
import assert from "node:assert/strict";
import test from "node:test";
import {
  attestOfficialCuaFrameContent,
  containsImageRefAuthority,
  containsOfficialCuaImageRefCredentialText,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES,
  parseOfficialCuaImageRef,
  preserveOfficialCuaFrameResult,
  readRasterEnvelopeIdentity,
} from "../frame-contract.js";

const VALID_REF = JSON.stringify({
  image_ref: { actionable: true, frame_id: "f-1", width: 20, height: 10 },
});

test("image-ref 凭据:精确形状才认", () => {
  assert.equal(isOfficialCuaImageRefText(VALID_REF), true);
  const parsed = parseOfficialCuaImageRef(VALID_REF);
  assert.equal(parsed.frame_id, "f-1");
  assert.equal(containsImageRefAuthority(VALID_REF), true);
  assert.equal(containsOfficialCuaImageRefCredentialText('{"image_ref":{}}'), true);

  // 键集/类型不符即拒(不猜)。
  assert.equal(isOfficialCuaImageRefText('{"image_ref":{"frame_id":"f"}}'), false);
  assert.equal(
    isOfficialCuaImageRefText(
      JSON.stringify({ image_ref: { actionable: false, frame_id: "f", width: 2, height: 2 } }),
    ),
    false,
  );
  assert.equal(isOfficialCuaImageRefText(`${VALID_REF}${VALID_REF}`), false);
  assert.equal(isOfficialCuaImageRefText("plain text"), false);
});

test("raster envelope 身份", () => {
  const identity = readRasterEnvelopeIdentity({ image: { mimeType: "image/png", data: "AAAA" } });
  assert.equal(identity.algorithm, "raster-envelope-v1");
  assert.equal(identity.mime, "image/png");
  assert.equal(readRasterEnvelopeIdentity({ image: { mimeType: "image/png" } }), undefined);
});

test("帧成对保留:image 与 image_ref 同在才成对,单边即无凭据", () => {
  const content = [
    { type: "text", text: "tree" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: VALID_REF },
  ];
  const pair = findOfficialCuaFrameContentPair(content);
  assert.equal(pair.imageIndex, 1);
  assert.equal(pair.imageRefIndex, 2);
  assert.equal(attestOfficialCuaFrameContent(content)?.kind, "official_cua_frame_v1");
  assert.equal(findOfficialCuaFrameContentPair([{ type: "image", data: "AAAA" }]), undefined);
});

test("preserveOfficialCuaFrameResult:超 200KB 内联图剥离字节,isError 原样", async () => {
  const huge = "A".repeat(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES + 1);
  const stripped = await preserveOfficialCuaFrameResult({
    content: [{ type: "image", data: huge, mimeType: "image/png" }],
  });
  assert.equal(stripped.content[0].type, "text");
  assert.match(stripped.content[0].text, /exceeds the inline image size limit/);

  const kept = await preserveOfficialCuaFrameResult({
    content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: VALID_REF }],
  });
  assert.equal(kept.content[0].type, "image");

  const errored = await preserveOfficialCuaFrameResult({ isError: true, content: [] });
  assert.equal(errored.isError, true);
});
