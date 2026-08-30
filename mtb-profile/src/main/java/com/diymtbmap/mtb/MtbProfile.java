package com.diymtbmap.mtb;

import com.onthegomap.planetiler.FeatureCollector;
import com.onthegomap.planetiler.Profile;
import com.onthegomap.planetiler.reader.SourceFeature;
import java.util.Map;

/**
 * Tileset profile that emits every OSM way tagged with a non-empty
 * {@code mtb:scale} as a line feature in layer {@code mtb}, carrying the raw
 * {@code mtb_scale} string (e.g. "h" / "x").
 *
 * <p>The feature zoom range is z{minZoom}..14 so the dedicated
 * {@code mtb.mbtiles} overlay is the single source of MTB trails at low
 * zooms, while the basemap tileset stays 100% stock (no mtb_scale at all).
 *
 * <p>Stateless: the build-time {@code --minzoom} (from the MTB_MINZOOM
 * build parameter) is captured at construction; nothing else is persisted
 * and there is no database.
 */
public class MtbProfile implements Profile {

  /** MBTiles layer name (and Martin source id) for the overlay tileset. */
  public static final String LAYER = "mtb";
  /** Feature attribute carrying the raw mtb:scale value. */
  public static final String ATTR = "mtb_scale";
  /** OSM tag that selects a way. */
  public static final String OSM_TAG = "mtb:scale";
  /** Hard upper zoom of the overlay tileset (matches the basemap maxzoom). */
  public static final int MAXZOOM = 14;

  private final int minZoom;

  public MtbProfile(int minZoom) {
    this.minZoom = minZoom;
  }

  @Override
  public void processFeature(SourceFeature feature, FeatureCollector features) {
    if (!feature.canBeLine()) {
      return;
    }
    String scale = feature.getString(OSM_TAG);
    if (scale == null || scale.isEmpty()) {
      return;
    }
    features.line(LAYER)
      .setZoomRange(minZoom, MAXZOOM)
      .setAttr(ATTR, scale);
  }

  @Override
  public String name() {
    return "MTB trails (mtb:scale)";
  }

  @Override
  public String description() {
    return "Every OSM way tagged with mtb:scale, as a dedicated low-zoom MTB overlay tileset.";
  }

  @Override
  public String attribution() {
    return OSM_ATTRIBUTION;
  }

  @Override
  public String version() {
    return "1.0.0";
  }

  @Override
  public boolean isOverlay() {
    return true;
  }

  @Override
  public Map<String, String> extraArchiveMetadata() {
    return Map.of("mtb_minzoom", Integer.toString(minZoom));
  }
}
