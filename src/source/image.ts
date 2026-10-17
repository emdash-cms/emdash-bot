// Recognise the image types a screenshot may be published as.

/** The image type from its leading bytes, never from a file name. */
export function imageType(bytes: Uint8Array): { ext: string; mime: string } | null {
	const at = (i: number, ...values: number[]) => values.every((v, j) => bytes[i + j] === v);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
		return { ext: "png", mime: "image/png" };
	if (at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
		return { ext: "webp", mime: "image/webp" };
	return null;
}
