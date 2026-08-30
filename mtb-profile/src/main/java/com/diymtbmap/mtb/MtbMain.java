package com.diymtbmap.mtb;

import com.onthegomap.planetiler.Planetiler;
import com.onthegomap.planetiler.config.Arguments;
import java.nio.file.Path;

/**
 * Entry point for the mtb:scale overlay tileset build.
 *
 * <p>Usage (as invoked by the app's build pipeline):
 * <pre>
 *   java -jar mtb-profile.jar \
 *        --osm_path=/data/input.osm.pbf \
 *        --output=/data/mtb.mbtiles \
 *        --minzoom=7 --maxzoom=14 \
 *        --force=true
 * </pre>
 *
 * <p>The {@code --minzoom} value (the MTB_MINZOOM build parameter, default 3)
 * both sets the MBTiles archive minzoom metadata and the feature zoom range,
 * so MTB trails (layer {@code mtb}, attribute {@code mtb_scale}) appear from
 * that zoom up to z14. {@code --maxzoom} is clamped to 14 by the profile.
 */
public final class MtbMain {
  private MtbMain() {}

  public static void main(String[] args) throws Exception {
    run(Arguments.fromArgsOrConfigFile(args));
  }

  static void run(Arguments arguments) throws Exception {
    Planetiler runner = Planetiler.create(arguments);
    int minZoom = runner.config().minzoom();
    if (minZoom > MtbProfile.MAXZOOM) {
      throw new IllegalArgumentException(
        "--minzoom must be <= " + MtbProfile.MAXZOOM + " (the tileset max zoom), was " + minZoom);
    }
    runner
      .setProfile(new MtbProfile(minZoom))
      .addOsmSource("osm", Path.of("input.osm.pbf"), null)
      .setOutput(Path.of("output.mbtiles"))
      .run();
  }
}
