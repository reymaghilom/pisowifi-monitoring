The authenticated app frame: sidebar, sticky header and page area.

Call `PisoWiFi.AppShell(active, title, subtitle, contentHTML, actionsHTML)`; the consumer provides the page content and one `active` key for the nav. The header holds the page title, search, refresh, theme toggle and profile. Below 900px render the sidebar as a drawer (`pw-drawer`) opened by a menu button, and turn tables into `pw-mcard` cards. Keep the "Prototype · Demo data" note in the sidebar footer while the data is mock.
