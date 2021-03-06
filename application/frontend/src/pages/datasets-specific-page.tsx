import React from "react";
import { useEnvRelay } from "../providers/env-relay-provider";
import { useQuery, useQueryClient } from "react-query";
import axios from "axios";
import { useNavigate, useParams } from "react-router-dom";
import { Box } from "../components/boxes";
import { DatasetDeepType, ReleaseDetailType } from "@umccr/elsa-types";
import { MyModal } from "../components/modals";
import { LayoutBase } from "../layouts/layout-base";

type DatasetsSpecificPageParams = {
  datasetId: string;
};

const DATASET_REACT_QUERY_KEY = "dataset";

export const DatasetsSpecificPage: React.FC = () => {
  const envRelay = useEnvRelay();
  const navigate = useNavigate();

  const { datasetId: datasetIdParam } = useParams<DatasetsSpecificPageParams>();

  const queryClient = useQueryClient();

  const { data: datasetData, isLoading: datasetIsLoading } = useQuery({
    queryKey: [DATASET_REACT_QUERY_KEY, datasetIdParam],
    queryFn: async ({ queryKey }) => {
      const did = queryKey[1];

      return await axios
        .get<DatasetDeepType>(`/api/datasets/${did}`)
        .then((response) => response.data);
    },
  });

  return (
    <LayoutBase>
      <MyModal />
      <div className="flex flex-row flex-wrap flex-grow mt-2">
        {datasetData && (
          <>
            <Box heading="Summary">
              <h5>Internal Id</h5>
              <p>{datasetData.id}</p>
              <h5>URI</h5>
              <p>{datasetData.uri}</p>
            </Box>

            <Box heading="Content">
              <p>
                {datasetData && (
                  <pre>{JSON.stringify(datasetData, null, 2)}</pre>
                )}
              </p>
            </Box>
          </>
        )}
      </div>
    </LayoutBase>
  );
};
