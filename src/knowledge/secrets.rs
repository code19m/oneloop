//! Credentials oneloop presents to Git hosts. Inbound secrets are stored only
//! as hashes, but an access token or deploy key must stay usable, so these are
//! encrypted with an instance key in the data directory's `keys/` folder. The
//! key travels with backups, so a restored instance can still sync.

use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use zeroize::Zeroizing;

use crate::{AppError, AppResult};

const KEY_FILE: &str = "knowledge.key";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const FORMAT: u8 = 1;

pub(crate) struct SecretBox {
    cipher: XChaCha20Poly1305,
}

/// What a sealed value is for. The purpose and project are authenticated, so
/// a value cannot be moved to another project or field.
#[derive(Clone, Copy)]
pub(crate) enum Purpose {
    Token,
    DeployKey,
}

impl Purpose {
    fn context(self, project_id: &str) -> String {
        let name = match self {
            Self::Token => "token",
            Self::DeployKey => "deploy-key",
        };
        format!("oneloop-knowledge-{name}:{project_id}")
    }
}

impl SecretBox {
    /// Read the instance key, creating it on first use.
    pub(crate) fn load_or_create(keys: &Path) -> AppResult<Self> {
        let path = keys.join(KEY_FILE);
        let key = match fs::read(&path) {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => create_key(keys, &path)?,
            Err(error) => return Err(error.into()),
        };
        if key.len() != KEY_BYTES {
            return Err(AppError::internal(format!(
                "{} is damaged; restore it from a backup",
                path.display()
            )));
        }
        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|_| AppError::internal("knowledge key has the wrong length"))?;
        Ok(Self { cipher })
    }

    pub(crate) fn seal(
        &self,
        purpose: Purpose,
        project_id: &str,
        plaintext: &[u8],
    ) -> AppResult<Vec<u8>> {
        let mut nonce = [0u8; NONCE_BYTES];
        random(&mut nonce)?;
        let context = purpose.context(project_id);
        let ciphertext = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| AppError::internal("credential encryption failed"))?;
        let mut sealed = Vec::with_capacity(1 + NONCE_BYTES + ciphertext.len());
        sealed.push(FORMAT);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(sealed)
    }

    /// `None` when the value was sealed with another key or was changed.
    pub(crate) fn open(
        &self,
        purpose: Purpose,
        project_id: &str,
        sealed: &[u8],
    ) -> Option<Zeroizing<Vec<u8>>> {
        let (&format, rest) = sealed.split_first()?;
        if format != FORMAT || rest.len() <= NONCE_BYTES {
            return None;
        }
        let (nonce, ciphertext) = rest.split_at(NONCE_BYTES);
        let context = purpose.context(project_id);
        self.cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: context.as_bytes(),
                },
            )
            .ok()
            .map(Zeroizing::new)
    }
}

/// Write the key to a private temporary file, then link it into place, so a
/// crash never leaves a short key and a concurrent first use keeps one key.
fn create_key(keys: &Path, path: &Path) -> AppResult<Zeroizing<Vec<u8>>> {
    crate::db::create_private_directories(keys)?;
    let mut key = Zeroizing::new(vec![0u8; KEY_BYTES]);
    random(&mut key)?;
    let temporary = keys.join(format!(".{KEY_FILE}.{}", uuid::Uuid::now_v7()));
    let mut file = crate::db::private_file_options()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&key)?;
    file.sync_all()?;
    drop(file);
    let linked = fs::hard_link(&temporary, path);
    fs::remove_file(&temporary)?;
    match linked {
        Ok(()) => {
            crate::db::sync_directory(keys)?;
            Ok(key)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Ok(Zeroizing::new(fs::read(path)?))
        }
        Err(error) => Err(error.into()),
    }
}

fn random(buffer: &mut [u8]) -> AppResult<()> {
    getrandom::fill(buffer)
        .map_err(|error| AppError::internal(format!("secure random generator failed: {error}")))
}

/// An SSH key pair a repository host can trust for read-only access.
pub(crate) struct DeployKey {
    /// One line in OpenSSH `authorized_keys` format.
    pub(crate) public: String,
    /// OpenSSH private key file contents.
    pub(crate) private: Zeroizing<String>,
}

pub(crate) fn generate_deploy_key(comment: &str) -> AppResult<DeployKey> {
    let mut seed = Zeroizing::new([0u8; 32]);
    random(seed.as_mut())?;
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    let mut public_blob = Vec::new();
    put_string(&mut public_blob, b"ssh-ed25519");
    put_string(&mut public_blob, &public);

    // The OpenSSH private key format with no passphrase.
    let mut check = [0u8; 4];
    random(&mut check)?;
    let mut keypair = Zeroizing::new([0u8; 64]);
    keypair[..32].copy_from_slice(seed.as_ref());
    keypair[32..].copy_from_slice(&public);
    let mut private = Zeroizing::new(Vec::new());
    private.extend_from_slice(&check);
    private.extend_from_slice(&check);
    put_string(&mut private, b"ssh-ed25519");
    put_string(&mut private, &public);
    put_string(&mut private, keypair.as_ref());
    put_string(&mut private, comment.as_bytes());
    let mut padding = 1u8;
    while private.len() % 8 != 0 {
        private.push(padding);
        padding += 1;
    }
    let mut body = Zeroizing::new(b"openssh-key-v1\0".to_vec());
    put_string(&mut body, b"none");
    put_string(&mut body, b"none");
    put_string(&mut body, b"");
    body.extend_from_slice(&1u32.to_be_bytes());
    put_string(&mut body, &public_blob);
    put_string(&mut body, &private);
    let encoded = Zeroizing::new(STANDARD.encode(body.as_slice()));
    let mut pem = Zeroizing::new(String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
    for line in encoded.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    Ok(DeployKey {
        public: format!("ssh-ed25519 {} {comment}", STANDARD.encode(&public_blob)),
        private: pem,
    })
}

fn put_string(buffer: &mut Vec<u8>, value: &[u8]) {
    buffer.extend_from_slice(
        &u32::try_from(value.len())
            .expect("short SSH field")
            .to_be_bytes(),
    );
    buffer.extend_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_values_open_only_for_their_purpose_and_project() {
        let directory = tempfile::tempdir().unwrap();
        let keys = directory.path().join("keys");
        let secrets = SecretBox::load_or_create(&keys).unwrap();
        let sealed = secrets
            .seal(Purpose::Token, "project-a", b"glpat-secret")
            .unwrap();
        assert!(!sealed.windows(12).any(|window| window == b"glpat-secret"));
        assert_eq!(
            secrets
                .open(Purpose::Token, "project-a", &sealed)
                .unwrap()
                .as_slice(),
            b"glpat-secret"
        );
        assert!(secrets.open(Purpose::Token, "project-b", &sealed).is_none());
        assert!(
            secrets
                .open(Purpose::DeployKey, "project-a", &sealed)
                .is_none()
        );

        let reopened = SecretBox::load_or_create(&keys).unwrap();
        assert!(
            reopened
                .open(Purpose::Token, "project-a", &sealed)
                .is_some()
        );
        let other = SecretBox::load_or_create(&directory.path().join("other")).unwrap();
        assert!(other.open(Purpose::Token, "project-a", &sealed).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_instance_key_is_private_and_damage_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let keys = directory.path().join("keys");
        SecretBox::load_or_create(&keys).unwrap();
        let mode = fs::metadata(keys.join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::write(keys.join(KEY_FILE), b"short").unwrap();
        assert!(SecretBox::load_or_create(&keys).is_err());
    }

    #[test]
    fn deploy_keys_are_valid_openssh_ed25519_keys() {
        let key = generate_deploy_key("oneloop").unwrap();
        let mut parts = key.public.split(' ');
        assert_eq!(parts.next(), Some("ssh-ed25519"));
        let blob = STANDARD.decode(parts.next().unwrap()).unwrap();
        assert_eq!(&blob[..15], b"\0\0\0\x0bssh-ed25519");
        assert_eq!(blob.len(), 4 + 11 + 4 + 32);
        assert!(
            key.private
                .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n")
        );
        assert_ne!(generate_deploy_key("oneloop").unwrap().public, key.public);

        // When OpenSSH is installed, it must derive the same public key.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("id");
        let mut file = crate::db::private_file_options()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(key.private.as_bytes()).unwrap();
        drop(file);
        match std::process::Command::new("ssh-keygen")
            .arg("-y")
            .arg("-f")
            .arg(&path)
            .output()
        {
            Ok(output) => {
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let derived = String::from_utf8(output.stdout).unwrap();
                let expected: Vec<_> = key.public.split(' ').take(2).collect();
                assert!(
                    derived.starts_with(&expected.join(" ")),
                    "{derived} != {}",
                    key.public
                );
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => panic!("ssh-keygen failed to start: {error}"),
        }
    }
}
