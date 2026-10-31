"use client";
import { useRef, useState } from "react";
import { ArrowUp, Folder, FolderOpen, X } from "lucide-react";
import { api } from "@/lib/client";
import { useLocale } from "./Locale";
import { Button, ErrorNotice, Input } from "./ui";
interface Listing {
  path: string;
  parent: string;
  writable: boolean;
  entries: { name: string; path: string }[];
}
export function DirectoryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<Listing>();
  const [address, setAddress] = useState(value);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function browse(path: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Listing>(
        `/api/directories?path=${encodeURIComponent(path)}`,
      );
      setListing(result);
      setAddress(result.path);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="input-action">
        <Input
          aria-label={t("Carpeta de destino", "Output folder")}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            dialog.current?.showModal();
            setAddress(value);
            void browse(value);
          }}
        >
          <FolderOpen size={16} />
          {t("Explorar", "Browse")}
        </Button>
      </div>
      <p className="field-hint">
        {t(
          "Carpeta en la máquina donde corre Reall. Cada proyecto tendrá su propia subcarpeta.",
          "Folder on the machine running Reall. Each project gets its own subfolder.",
        )}
      </p>
      <dialog ref={dialog} className="folder-dialog">
        <div className="section-heading">
          <div>
            <h2>{t("Elegí una carpeta", "Choose a folder")}</h2>
            <p>
              {t(
                "Explorá el sistema de archivos de Reall.",
                "Browse Reall's filesystem.",
              )}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={t("Cerrar", "Close")}
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="input-action">
          <Input
            aria-label={t("Ruta", "Path")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void browse(address);
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            busy={busy}
            onClick={() => void browse(address)}
          >
            {t("Ir", "Go")}
          </Button>
        </div>
        <ErrorNotice message={error} />
        <div className="folder-list">
          {listing && (
            <button type="button" onClick={() => void browse(listing.parent)}>
              <ArrowUp size={16} />
              {t("Carpeta superior", "Parent folder")}
            </button>
          )}
          {listing?.entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              onClick={() => void browse(entry.path)}
            >
              <Folder size={17} />
              {entry.name}
            </button>
          ))}
        </div>
        <div className="form-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={() => dialog.current?.close()}
          >
            {t("Cancelar", "Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!listing?.writable || busy || Boolean(error)}
            onClick={() => {
              if (listing) onChange(listing.path);
              dialog.current?.close();
            }}
          >
            {t("Usar esta carpeta", "Use this folder")}
          </Button>
        </div>
      </dialog>
    </>
  );
}
