import { SourceFooter } from './source-footer'

export function Home () {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
        <title></title>
        <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
        <style dangerouslySetInnerHTML={{
          __html: `
            html, body {
              margin: 0;
              height: 100vh;
              background: #262626;
            }
            body {
              display: flex;
              justify-content: center;
              align-items: center;
            }
            img {
              max-width: 280px;
              height: 280px;
              opacity: 0.3;
            }
            /* The section 13 offer must stay visible on this page too. */
            #source-offer {
              position: fixed;
              bottom: 0;
              width: 100%;
              padding: 1rem;
              text-align: center;
              font-size: 0.8rem;
            }
            #source-offer a {
              color: #fff;
              opacity: 0.4;
              text-decoration: none;
              border-bottom: 1px dotted currentColor;
            }
            #source-offer a:hover { opacity: 0.9; }
          `
        }}/>
      </head>
      <body>
        <div class="container">
          <a href="https://github.com/alangrainger/immich-public-proxy">
            <img src="/share/static/images/ipp.svg" alt=""/>
          </a>
        </div>
        <SourceFooter/>
      </body>
    </html>
  )
}
