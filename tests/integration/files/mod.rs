//! Attachments, avatars, previews, storage capacity and cleanup.

pub(crate) mod http;
mod sanitizer;
mod service;
mod thumbnails;

/// A lossless WebP of one colour. Its pixels take no bits, so the file is a
/// few dozen bytes at any size.
pub(crate) fn flat_webp(width: u32, height: u32) -> Vec<u8> {
    let mut fields = vec![
        (0x2f, 8),
        (width - 1, 14),
        (height - 1, 14),
        // No alpha, version 0, no transform, no colour cache, one prefix-code
        // group.
        (0, 1),
        (0, 3),
        (0, 1),
        (0, 1),
        (0, 1),
    ];
    // Green, red, blue, alpha and distance each have a one-symbol code,
    // written with eight bits.
    for symbol in [120, 60, 200, 255, 0] {
        fields.extend([(1, 1), (0, 1), (1, 1), (symbol, 8)]);
    }
    let mut data = Vec::new();
    let (mut bits, mut count) = (0_u64, 0);
    for (value, width) in fields {
        bits |= u64::from(value) << count;
        count += width;
        while count >= 8 {
            data.push(bits as u8);
            bits >>= 8;
            count -= 8;
        }
    }
    if count > 0 {
        data.push(bits as u8);
    }
    if data.len() % 2 == 1 {
        data.push(0);
    }
    let mut webp = b"RIFF".to_vec();
    webp.extend_from_slice(&(12 + data.len() as u32).to_le_bytes());
    webp.extend_from_slice(b"WEBPVP8L");
    webp.extend_from_slice(&(data.len() as u32).to_le_bytes());
    webp.extend_from_slice(&data);
    webp
}
