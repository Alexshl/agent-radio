import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { S } from '../i18n'

// QR code as inline SVG, generated in the browser (the stream link never leaves it).
export function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    let live = true
    QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#14181f', light: '#ffffff' } }).then(
      (s) => live && setSvg(s),
      () => live && setSvg(''),
    )
    return () => {
      live = false
    }
  }, [text])
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG is produced by the qrcode library from our own URL
  return <div className="ar-qr" role="img" aria-label={S.radio.qrAlt} dangerouslySetInnerHTML={{ __html: svg }} />
}
