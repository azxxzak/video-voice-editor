# Видео ба дуу засагч

Хөтөч дотор ажилладаг энгийн видео, дууны засвар. **Бүх зүйл таны төхөөрөмж дээр хийгдэнэ** — файл хаашаа ч илгээгдэхгүй. Утас болон компьютер дээр ажиллана.

**Видео**
- **Хоёр талаас нь тайрах** — эхлэл, төгсгөлийн хоорондох хэсгийг үлдээнэ.
- **Голоос нь таслах** — хоорондох хэсгийг хасаад үлдсэнийг залгана.
- **Дуу салгах** — MP3, WAV эсвэл M4A (шууд дуу засагч руу оруулж болно).
- **Дуугүй болгох** — видеоны дууг хасна.

**Дуу**
- Файл оруулах эсвэл **микрофоноор хураах**.
- Долгион дээр чирж хэсэг сонгоно: үлдээх, устгах, дуугүй болгох, чимээгүйг автоматаар хасах,
  дууны хэмжээ (дБ), тэгшлэх, аажим эхлэх/дуусах, буцаах.
- MP3 эсвэл WAV болгож татна.

[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (видео, MP3) ба Web Audio API ашигласан. Framework, bundler байхгүй.

## Local дээр ажиллуулах

```bash
npm install
npm run dev        # public/vendor-ийг бэлтгээд http://localhost:5199 дээр ажиллуулна
```

## Vercel дээр байршуулах

1. GitHub repo-г Vercel дээр Import хийнэ.
2. `vercel.json` нь Install `npm install`, Build `npm run build`, Output `public` гэж тохируулсан тул өөрчлөх шаардлагагүй.

Build үед ffmpeg.wasm (~32 MB) `node_modules`-оос `public/vendor` руу хуулагддаг тул git-д хадгалагдахгүй.

## Тэмдэглэл

- Файл хөтөчийн санах ойд боловсруулагддаг тул хэдэн зуун MB-аас бага видео сайн.
- Дахин кодлосон видео MP4 (H.264 + AAC) болно. «Хурдан горим» ба «Дуугүй болгох» нь анхны кодекийг хэвээр
  хадгалдаг тул гаралт анхны формат (жишээ нь `.webm`) хэвээр үлдэнэ.
- Микрофон ашиглахад https эсвэл `localhost` хэрэгтэй (Vercel нь https).

---

# English

Browser-based video trimmer ("crop both sides" / "cut the middle"), audio extractor, mute tool and
voice recorder/editor, with a Mongolian UI. Everything runs client-side (ffmpeg.wasm + Web Audio).
`npm install && npm run dev`, deploy as a static site on Vercel (`vercel.json` included).
