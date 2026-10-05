//! Decoding of untrusted PNG, JPEG and WebP files for avatars and thumbnails.
//! The JPEG and WebP decoders take no allocation limit, so an estimate from
//! the file's header refuses an image before any pixels are decoded when the
//! decode would need more memory than one decode may use.
use super::*;
use std::io::{BufRead, Read, Seek, SeekFrom};

use image::{DynamicImage, ImageDecoder, ImageError, metadata::Orientation};

/// The longest side of an image the server decodes.
pub(super) const MAX_SIDE: u32 = 8192;
/// The most bytes of decoded pixels: 8192 × 5461 RGB, or a 4096 × 4096
/// 16-bit RGBA PNG.
pub(super) const MAX_PIXEL_BYTES: u64 = 128 * 1024 * 1024;
/// The most memory one decode may use by the header estimate: the file, the
/// pixels and the decoder's buffers. A 24-megapixel JPEG needs about 75 MiB,
/// or about 145 MiB when it is progressive.
pub(super) const MAX_DECODE_MEMORY: u64 = 192 * 1024 * 1024;
/// What the PNG decoder may allocate for chunks such as an ICC profile or
/// text. It is the only decoder that takes this limit.
const MAX_DECODER_ALLOCATION: u64 = 16 * 1024 * 1024;

pub(super) enum DecodeFailure {
    /// Reading the file failed; a later attempt may work.
    Io(std::io::Error),
    /// Not a supported image, damaged, or too big to decode within the limits.
    Refused,
}

/// Decodes an image of `size` bytes, after the header estimate allows it, and
/// returns it with its Exif orientation.
pub(super) fn decode_untrusted<R: BufRead + Seek>(
    reader: R,
    size: u64,
) -> Result<(DynamicImage, Orientation), DecodeFailure> {
    let mut decoder = untrusted_decoder(reader, size)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let image = DynamicImage::from_decoder(decoder).map_err(failure)?;
    Ok((image, orientation))
}

/// The decoder of an image of `size` bytes, once its header shows that the
/// decode fits the limits.
fn untrusted_decoder<'a, R: BufRead + Seek + 'a>(
    mut reader: R,
    size: u64,
) -> Result<impl ImageDecoder + 'a, DecodeFailure> {
    let format = ImageReader::new(&mut reader)
        .with_guessed_format()
        .map_err(DecodeFailure::Io)?
        .format();
    let Some(format @ (ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) = format else {
        return Err(DecodeFailure::Refused);
    };
    let memory = decode_memory(format, &mut reader, size).map_err(DecodeFailure::Io)?;
    if memory.is_none_or(|memory| memory > MAX_DECODE_MEMORY) {
        return Err(DecodeFailure::Refused);
    }
    reader.seek(SeekFrom::Start(0)).map_err(DecodeFailure::Io)?;
    let mut image_reader = ImageReader::with_format(reader, format);
    image_reader.limits(image_limits());
    let decoder = image_reader.into_decoder().map_err(failure)?;
    if decoder.total_bytes() > MAX_PIXEL_BYTES {
        return Err(DecodeFailure::Refused);
    }
    Ok(decoder)
}

fn image_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    // On this path the pixels aren't charged to the limit, which only bounds
    // what the PNG decoder allocates for its chunks.
    limits.max_alloc = Some(MAX_DECODER_ALLOCATION);
    limits
}

fn failure(error: ImageError) -> DecodeFailure {
    match error {
        ImageError::IoError(error) if error.kind() != std::io::ErrorKind::UnexpectedEof => {
            DecodeFailure::Io(error)
        }
        _ => DecodeFailure::Refused,
    }
}

/// The memory that decoding the image would need, from its header, or `None`
/// when the header isn't one oneloop understands.
fn decode_memory(
    format: ImageFormat,
    reader: &mut (impl Read + Seek),
    size: u64,
) -> std::io::Result<Option<u64>> {
    reader.seek(SeekFrom::Start(0))?;
    let estimate = match format {
        ImageFormat::Jpeg => jpeg_memory(reader),
        ImageFormat::Png => png_memory(reader),
        ImageFormat::WebP => webp_memory(reader),
        _ => Ok(None),
    };
    match estimate {
        // A header that ends early is damaged, not unreadable.
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        // Decoders read the whole file into memory.
        estimate => Ok(estimate?.map(|memory| memory.saturating_add(size))),
    }
}

/// zune-jpeg decodes into the pixels with one row of blocks at a time, but a
/// progressive image keeps every coefficient, two bytes each, until its last
/// scan. CMYK and YCCK images decode four components into RGB pixels.
fn jpeg_memory(reader: &mut (impl Read + Seek)) -> std::io::Result<Option<u64>> {
    let mut start = [0; 2];
    reader.read_exact(&mut start)?;
    if start != [0xff, 0xd8] {
        return Ok(None);
    }
    for _ in 0..1024 {
        let mut byte = [0; 1];
        reader.read_exact(&mut byte)?;
        if byte[0] != 0xff {
            return Ok(None);
        }
        // Markers may be padded with any number of 0xff fill bytes.
        while byte[0] == 0xff {
            reader.read_exact(&mut byte)?;
        }
        let marker = byte[0];
        match marker {
            0x01 | 0xd0..=0xd7 => continue,
            // A scan, the end, or a second start before any frame header.
            0xd8..=0xda => return Ok(None),
            _ => {}
        }
        let mut length = [0; 2];
        reader.read_exact(&mut length)?;
        let length = u16::from_be_bytes(length);
        if length < 2 {
            return Ok(None);
        }
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let mut frame = vec![0; usize::from(length - 2)];
            reader.read_exact(&mut frame)?;
            let progressive = matches!(marker, 0xc2 | 0xc6 | 0xca | 0xce);
            return Ok(jpeg_frame_memory(&frame, progressive));
        }
        reader.seek(SeekFrom::Current(i64::from(length - 2)))?;
    }
    Ok(None)
}

fn jpeg_frame_memory(frame: &[u8], progressive: bool) -> Option<u64> {
    let [
        _,
        height_high,
        height_low,
        width_high,
        width_low,
        count,
        ref components @ ..,
    ] = *frame
    else {
        return None;
    };
    let height = u64::from(u16::from_be_bytes([height_high, height_low]));
    let width = u64::from(u16::from_be_bytes([width_high, width_low]));
    let count = usize::from(count);
    if !(1..=4).contains(&count) || components.len() < count * 3 || !within_sides(width, height) {
        return None;
    }
    let sampling = components
        .chunks_exact(3)
        .take(count)
        .map(|component| (u64::from(component[1] >> 4), u64::from(component[1] & 0x0f)))
        .collect::<Vec<_>>();
    if sampling
        .iter()
        .any(|&(h, v)| !(1..=4).contains(&h) || !(1..=4).contains(&v))
    {
        return None;
    }
    let h_max = sampling.iter().map(|&(h, _)| h).max()?;
    let v_max = sampling.iter().map(|&(_, v)| v).max()?;
    let (mcu_columns, mcu_rows) = (width.div_ceil(8 * h_max), height.div_ceil(8 * v_max));
    let coefficients = match (progressive, count) {
        (false, _) => 0,
        (true, 1) => 2 * width.div_ceil(8) * 8 * height.div_ceil(8) * 8,
        (true, _) => sampling
            .iter()
            .map(|&(h, v)| 2 * mcu_columns * 8 * h * mcu_rows * 8 * v)
            .sum(),
    };
    let pixels = width * height * if count == 1 { 1 } else { 3 };
    // A row of blocks per component for the inverse DCT, upsampling and
    // colour conversion.
    let rows = mcu_columns * 8 * h_max * 8 * v_max * count as u64 * 4;
    Some(pixels + coefficients + rows)
}

/// The PNG decoder writes rows straight into the pixels; its own buffers and
/// chunks stay within its allocation limit.
fn png_memory(reader: &mut impl Read) -> std::io::Result<Option<u64>> {
    let mut header = [0; 26];
    reader.read_exact(&mut header)?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return Ok(None);
    }
    let width = u64::from(u32::from_be_bytes([
        header[16], header[17], header[18], header[19],
    ]));
    let height = u64::from(u32::from_be_bytes([
        header[20], header[21], header[22], header[23],
    ]));
    let channels = match header[25] {
        0 => 1,
        2 => 3,
        // A palette expands to RGB, or to RGBA with transparency.
        3 => 4,
        4 => 2,
        6 => 4,
        _ => return Ok(None),
    };
    let sample_bytes = if header[24] == 16 { 2 } else { 1 };
    if !within_sides(width, height) {
        return Ok(None);
    }
    Ok(Some(
        width * height * channels * sample_bytes + MAX_DECODER_ALLOCATION,
    ))
}

/// image-webp decodes a lossy frame to YUV and a lossless one to RGBA, then
/// converts it into the pixels; an animation also keeps an RGBA canvas. Bytes
/// per pixel are doubled here to stay whole.
fn webp_memory(reader: &mut impl Read) -> std::io::Result<Option<u64>> {
    let mut header = [0; 30];
    reader.read_exact(&mut header)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Ok(None);
    }
    let chunk = &header[20..];
    let (width, height, doubled_bytes_per_pixel) = match &header[12..16] {
        b"VP8 " => {
            if chunk[3..6] != [0x9d, 0x01, 0x2a] {
                return Ok(None);
            }
            let width = u16::from_le_bytes([chunk[6], chunk[7]]) & 0x3fff;
            let height = u16::from_le_bytes([chunk[8], chunk[9]]) & 0x3fff;
            // RGB pixels and the YUV frame.
            (u64::from(width), u64::from(height), 9)
        }
        b"VP8L" => {
            if chunk[0] != 0x2f {
                return Ok(None);
            }
            let bits = u32::from_le_bytes([chunk[1], chunk[2], chunk[3], chunk[4]]);
            // The pixels and the RGBA frame.
            (
                u64::from(bits & 0x3fff) + 1,
                u64::from((bits >> 14) & 0x3fff) + 1,
                16,
            )
        }
        b"VP8X" => {
            let flags = chunk[0];
            let width = u64::from(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], 0])) + 1;
            let height = u64::from(u32::from_le_bytes([chunk[7], chunk[8], chunk[9], 0])) + 1;
            let doubled = if flags & 0x02 != 0 {
                // Animated: the first frame, an RGBA canvas and the pixels.
                32
            } else if flags & 0x10 != 0 {
                // With alpha: RGBA pixels and frame, YUV and the alpha plane.
                22
            } else {
                14
            };
            (width, height, doubled)
        }
        _ => return Ok(None),
    };
    if !within_sides(width, height) {
        return Ok(None);
    }
    Ok(Some(width * height * doubled_bytes_per_pixel / 2))
}

fn within_sides(width: u64, height: u64) -> bool {
    (1..=u64::from(MAX_SIDE)).contains(&width) && (1..=u64::from(MAX_SIDE)).contains(&height)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG that ends after its frame header: enough for the estimate.
    fn jpeg_header(marker: u8, width: u16, height: u16, sampling: &[u8]) -> Vec<u8> {
        let mut frame = vec![8];
        frame.extend_from_slice(&height.to_be_bytes());
        frame.extend_from_slice(&width.to_be_bytes());
        frame.push(sampling.len() as u8);
        for (id, factors) in sampling.iter().enumerate() {
            frame.extend_from_slice(&[id as u8 + 1, *factors, 0]);
        }
        let mut bytes = vec![0xff, 0xd8];
        // An Exif segment comes before the frame header, as in photos.
        bytes.extend_from_slice(&[0xff, 0xe1, 0x00, 0x08, b'E', b'x', b'i', b'f', 0, 0]);
        bytes.extend_from_slice(&[0xff, marker]);
        bytes.extend_from_slice(&(frame.len() as u16 + 2).to_be_bytes());
        bytes.extend_from_slice(&frame);
        bytes
    }

    fn estimate(format: ImageFormat, bytes: &[u8]) -> Option<u64> {
        decode_memory(format, &mut std::io::Cursor::new(bytes), 0).unwrap()
    }

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn photos_fit_the_budget_and_hostile_jpegs_do_not() {
        let baseline = estimate(
            ImageFormat::Jpeg,
            &jpeg_header(0xc0, 6000, 4000, &[0x22, 0x11, 0x11]),
        );
        let progressive = estimate(
            ImageFormat::Jpeg,
            &jpeg_header(0xc2, 6000, 4000, &[0x22, 0x11, 0x11]),
        );
        let progressive_444 = estimate(
            ImageFormat::Jpeg,
            &jpeg_header(0xc2, 8192, 5461, &[0x11; 3]),
        );
        let progressive_cmyk = estimate(
            ImageFormat::Jpeg,
            &jpeg_header(0xc2, 6000, 4000, &[0x11; 4]),
        );
        // Measured peaks, with the file and the process: 76, 145, 387 and 264 MiB.
        assert!(
            (65 * MIB..80 * MIB).contains(&baseline.unwrap()),
            "{baseline:?}"
        );
        assert!(
            (135 * MIB..MAX_DECODE_MEMORY).contains(&progressive.unwrap()),
            "{progressive:?}"
        );
        assert!(progressive_444.unwrap() > 380 * MIB, "{progressive_444:?}");
        assert!(
            progressive_cmyk.unwrap() > 240 * MIB,
            "{progressive_cmyk:?}"
        );
    }

    #[test]
    fn webp_and_png_estimates_follow_their_decoders() {
        let webp = |chunk: &[u8; 4], payload: [u8; 10]| {
            let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
            bytes.extend_from_slice(chunk);
            bytes.extend_from_slice(&[0; 4]);
            bytes.extend_from_slice(&payload);
            estimate(ImageFormat::WebP, &bytes)
        };
        let side = |value: u32| (value - 1).to_le_bytes();
        let (w, h) = (side(8192), side(4096));
        let animated = webp(b"VP8X", [0x12, 0, 0, 0, w[0], w[1], w[2], h[0], h[1], h[2]]);
        let lossy = webp(b"VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x70, 0x17, 0xa0, 0x0f]);
        // Measured peaks: 472 MiB, and 79 MiB for a 6000 × 4000 lossy image.
        assert!(animated.unwrap() > 470 * MIB, "{animated:?}");
        assert!((95 * MIB..110 * MIB).contains(&lossy.unwrap()), "{lossy:?}");
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&4096_u32.to_be_bytes());
        png.extend_from_slice(&4096_u32.to_be_bytes());
        png.extend_from_slice(&[16, 6]);
        // 16-bit RGBA at the pixel limit, measured at 131 MiB.
        assert_eq!(estimate(ImageFormat::Png, &png), Some(144 * MIB));
    }

    #[test]
    fn png_metadata_stays_within_the_decoder_allowance() {
        let png = |profile: usize| {
            let mut bytes = Vec::new();
            let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
            encoder.set_icc_profile(vec![0; profile]).unwrap();
            encoder
                .write_image(&[40; 64 * 64 * 3], 64, 64, image::ExtendedColorType::Rgb8)
                .unwrap();
            bytes
        };
        let profile = |bytes: Vec<u8>| {
            let size = bytes.len() as u64;
            let Ok(mut decoder) = untrusted_decoder(std::io::Cursor::new(bytes), size) else {
                panic!("the image decodes");
            };
            decoder.icc_profile().unwrap().map(|profile| profile.len())
        };
        // A colour profile a few kilobytes long can inflate to any size. It
        // stops at the allowance and is left out, and the image still decodes.
        assert_eq!(profile(png(4 * MIB as usize)), Some(4 * MIB as usize));
        assert_eq!(profile(png(20 * MIB as usize)), None);
        let inflating = png(20 * MIB as usize);
        let size = inflating.len() as u64;
        assert!(decode_untrusted(std::io::Cursor::new(inflating), size).is_ok());
    }

    #[test]
    fn headers_the_estimate_cannot_read_are_refused() {
        for bytes in [
            &jpeg_header(0xc2, 9000, 100, &[0x11; 3])[..],
            &jpeg_header(0xc2, 100, 100, &[0x11; 5])[..],
            &jpeg_header(0xc0, 100, 100, &[0x51])[..],
            &[0xff, 0xd8, 0xff, 0xda, 0, 2][..],
            &[0xff, 0xd8, 0xff][..],
        ] {
            assert_eq!(estimate(ImageFormat::Jpeg, bytes), None, "{bytes:02x?}");
        }
    }
}
